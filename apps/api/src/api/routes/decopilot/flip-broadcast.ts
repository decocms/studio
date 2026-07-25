/**
 * NATS "flip to background" broadcast.
 *
 * Moving a running foreground subtask to the background must reach whichever
 * pod is executing that turn — like thread-cancel, there's no pod affinity, so
 * it fans out over NATS Core pub/sub (see `nats-cancel-broadcast.ts` for the
 * same pattern). Each pod's subscriber calls `requestFlip` against its local
 * `flip-registry`; the pod running the turn resolves the waiting generator.
 *
 * Fire-and-forget, like cancel: if no pod is running the call, the flip is a
 * no-op (the turn already finished, or nothing to flip). The (threadId,
 * toolCallId) pair rides the JSON payload, never the subject, so neither can
 * carry a NATS wildcard.
 */

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import { requestFlip } from "@/harnesses/decopilot/flip-registry";

const FLIP_SUBJECTS = ["studio.decopilot.flip", "mesh.decopilot.flip"] as const;

let getConnection: (() => NatsConnection | null) | null = null;
let subscriptions: Subscription[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const originId = crypto.randomUUID();

interface FlipMessage {
  threadId: string;
  toolCallId: string;
  originId?: string;
}

/** Wire the NATS connection getter and (re)subscribe. Safe to call again on
 *  NATS reconnect — it re-subscribes only when not already subscribed. */
export function initFlipBroadcast(getConn: () => NatsConnection | null): void {
  getConnection = getConn;
  if (subscriptions.length > 0) return;
  const nc = getConnection();
  if (!nc) return; // NATS not ready — local flips still work via broadcastFlip
  subscriptions = FLIP_SUBJECTS.map((subject) => nc.subscribe(subject));
  for (const subscription of subscriptions) {
    (async () => {
      for await (const msg of subscription) {
        try {
          const parsed = JSON.parse(decoder.decode(msg.data)) as FlipMessage;
          if (parsed.originId === originId) continue; // already handled locally
          requestFlip(parsed.threadId, parsed.toolCallId);
        } catch {
          // Ignore malformed messages.
        }
      }
    })().catch(console.error);
  }
}

/** Flip a specific in-flight tool call to background: resolve it locally, then
 *  fan out so the pod actually running the turn resolves it too. */
export function broadcastFlip(threadId: string, toolCallId: string): void {
  requestFlip(threadId, toolCallId);
  try {
    const nc = getConnection?.();
    if (!nc) return; // NATS not ready — local flip only (single-pod dev)
    const encoded = encoder.encode(
      JSON.stringify({ threadId, toolCallId, originId } satisfies FlipMessage),
    );
    for (const subject of FLIP_SUBJECTS) nc.publish(subject, encoded);
  } catch (err) {
    console.warn("[FlipBroadcast] Publish failed (non-critical):", err);
  }
}

export function stopFlipBroadcast(): void {
  for (const subscription of subscriptions) subscription.unsubscribe();
  subscriptions = [];
  getConnection = null;
}
