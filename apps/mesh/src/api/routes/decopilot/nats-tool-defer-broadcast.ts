/**
 * Fans a "send this running tool call to the background" request across pods via
 * NATS Core pub/sub, mirroring `NatsCancelBroadcast`. `broadcast` notifies the
 * local pod AND publishes to others; whichever holds the live registration acts.
 * Fire-and-forget (a dead pod has nothing to defer); local-only until NATS.
 */

import type { NatsConnection, Subscription } from "@nats-io/nats-core";

const SUBJECT = "mesh.decopilot.tool-defer";

export interface ToolDeferBroadcast {
  /** Start listening for cross-pod defer requests; `onDefer` fires locally. */
  start(onDefer?: (toolCallId: string) => void): Promise<void>;
  /** Defer a running tool call: notify the local pod, then fan out to others. */
  broadcast(toolCallId: string): void;
  /** Stop listening and release resources. */
  stop(): Promise<void>;
}

export interface NatsToolDeferBroadcastOptions {
  getConnection: () => NatsConnection | null;
}

export class NatsToolDeferBroadcast implements ToolDeferBroadcast {
  private sub: Subscription | null = null;
  private onDefer: ((toolCallId: string) => void) | null = null;
  private readonly encoder = new TextEncoder();
  private readonly originId = crypto.randomUUID();

  constructor(private readonly options: NatsToolDeferBroadcastOptions) {}

  async start(onDefer?: (toolCallId: string) => void): Promise<void> {
    if (onDefer) this.onDefer = onDefer;

    if (this.sub) return;
    if (!this.onDefer) return;

    const nc = this.options.getConnection();
    if (!nc) return; // NATS not ready — local defer only

    this.sub = nc.subscribe(SUBJECT);
    const decoder = new TextDecoder();

    (async () => {
      for await (const msg of this.sub!) {
        try {
          const parsed = JSON.parse(decoder.decode(msg.data)) as {
            toolCallId: string;
            originId?: string;
          };
          if (parsed.originId === this.originId) continue;
          this.onDefer?.(parsed.toolCallId);
        } catch {
          // Ignore malformed messages
        }
      }
    })().catch(console.error);
  }

  broadcast(toolCallId: string): void {
    if (/[.*>\s]/.test(toolCallId)) {
      console.warn(
        "[NatsToolDeferBroadcast] invalid toolCallId, skipping broadcast",
      );
      return;
    }

    // Local pod first — the run may be here.
    this.onDefer?.(toolCallId);

    try {
      const nc = this.options.getConnection();
      if (!nc) return; // NATS not ready — local defer only
      nc.publish(
        SUBJECT,
        this.encoder.encode(
          JSON.stringify({ toolCallId, originId: this.originId }),
        ),
      );
    } catch (err) {
      console.warn(
        "[NatsToolDeferBroadcast] Publish failed (non-critical):",
        err,
      );
    }
  }

  async stop(): Promise<void> {
    this.sub?.unsubscribe();
    this.sub = null;
    this.onDefer = null;
  }
}
