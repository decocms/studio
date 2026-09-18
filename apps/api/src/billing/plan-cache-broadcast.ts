/**
 * Cross-pod invalidation for the plan-feature-gate cache.
 *
 * `invalidateOrgFeaturesCache` drops one entry from a per-process `Map`, so the
 * pod that took the Stripe webhook learns immediately and every OTHER pod waits
 * out its 60s TTL. For a minute after paying, whether an org's new features
 * work depends on which replica its next request lands on — the paywall it just
 * bought its way past reappears at random. The same minute runs the other way
 * on a cancellation, where the org keeps spending on a plan it no longer has.
 *
 * NATS Core pub/sub, the lane `NatsSSEBroadcast` already uses, with the same
 * origin-id guard so the publisher does not process its own message. No new
 * infrastructure and no new connection: it borrows the shared one.
 *
 * Best-effort by construction, and that is the right bar. A missed message
 * costs exactly the 60s TTL this exists to shorten — the state it was already
 * in — so nothing here retries, acks or persists. With no NATS configured
 * (local dev, self-hosted single pod) it is inert and the TTL is the whole
 * mechanism, which for one pod is already correct.
 */

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import { invalidateOrgFeaturesCache } from "@/core/plan-feature-gate";

const SUBJECT = "studio.plans.invalidate";

interface InvalidateMessage {
  originId: string;
  organizationId: string;
}

const originId = crypto.randomUUID();

let getConnection: (() => NatsConnection | null) | null = null;
let subscription: Subscription | null = null;
const encoder = new TextEncoder();

/**
 * Start listening for other pods' invalidations. Safe to call before NATS is
 * up — `onReady` in the caller re-invokes it, and a second call with a live
 * subscription is a no-op.
 */
export function startPlanCacheBroadcast(
  connectionProvider: () => NatsConnection | null,
): void {
  getConnection = connectionProvider;
  if (subscription) return;
  const nc = connectionProvider();
  if (!nc) return; // Not ready — publishing still degrades to local-only.

  subscription = nc.subscribe(SUBJECT);
  const decoder = new TextDecoder();
  void (async () => {
    for await (const msg of subscription) {
      try {
        const parsed = JSON.parse(
          decoder.decode(msg.data),
        ) as Partial<InvalidateMessage>;
        if (typeof parsed.organizationId !== "string") continue;
        if (parsed.originId === originId) continue;
        invalidateOrgFeaturesCache(parsed.organizationId);
      } catch {
        // A malformed message is one pod's bug, not a reason to stop listening.
      }
    }
  })();
}

/**
 * Drop this org's cached plan on EVERY pod.
 *
 * Invalidates locally first and unconditionally, so the behaviour with no NATS
 * is exactly what it was before this existed. The publish is the addition, and
 * it cannot fail the caller: a plan change must not be rolled back because a
 * cache hint did not go out.
 */
export function invalidateOrgFeaturesEverywhere(organizationId: string): void {
  invalidateOrgFeaturesCache(organizationId);
  try {
    const nc = getConnection?.() ?? null;
    if (!nc) return;
    const message: InvalidateMessage = { originId, organizationId };
    nc.publish(SUBJECT, encoder.encode(JSON.stringify(message)));
  } catch (err) {
    console.warn("[plans] cross-pod cache invalidation failed to publish", {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test seam: drop the subscription so a suite can re-start cleanly. */
export function stopPlanCacheBroadcast(): void {
  subscription?.unsubscribe();
  subscription = null;
  getConnection = null;
}
