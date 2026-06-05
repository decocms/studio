/**
 * Work long-poll endpoint for pull-transport daemons (spec §3.2).
 *
 * GET /api/:org/links/work
 *
 * The daemon holds this connection continuously (even idle). Each poll cycle:
 *   1. Refreshes the studio_links presence claim (TTL re-arms on put).
 *   2. Waits up to POLL_TIMEOUT_MS for the next work item on the per-user
 *      JetStream consumer.
 *   3. ACKs the message immediately (ACK-ON-DELIVERY) and returns the item.
 *   4. Returns 204 if the poll window expires with no item.
 *
 * Presence: stop polling → claim expires (60 s TTL) → resolveDispatchTarget
 * returns 409 link_unavailable for new dispatches (L3).
 *
 * Redelivery-on-desktop-death is out of scope for Phase B; it is handled
 * by the progress-staleness sweeper in a later phase.
 */
import { Hono } from "hono";
import type { Env } from "../../hono-env";
import type { LinkClaimRegistry, LinkClaim } from "@/links/link-claim-registry";
import type { LinkWorkQueue } from "./link-work-queue";

export interface LinkWorkDeps {
  linkClaimRegistry: LinkClaimRegistry;
  workQueue: LinkWorkQueue;
}

// Just under a typical 30 s HTTP gateway timeout.
// consumer.fetch uses `expires` in ms; nats.js minimum is 1000 ms.
const POLL_TIMEOUT_MS = 29_000;

export function createLinkWorkRoutes(deps: LinkWorkDeps) {
  const app = new Hono<Env>();

  app.get("/links/work", async (c) => {
    const ctx = c.get("meshContext");
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    // Refresh presence claim — TTL re-arms on every put (spec §3.2).
    const existing = await deps.linkClaimRegistry.get(userId);
    const refreshed: LinkClaim = existing
      ? { ...existing, connectedAt: Date.now() }
      : {
          // First poll for this user in this session: synthesize a sentinel
          // claim. The daemon will overwrite this with its real capabilities
          // once Phase C lands the hello-on-poll handshake. For Phase B the
          // key property is that the claim is non-null so resolveDispatchTarget
          // considers the link online.
          podId: `pull-${userId}`,
          machineId: userId,
          cliVersion: "pull-phase-b",
          previewPort: 0,
          connectedAt: Date.now(),
          capabilities: [],
        };
    await deps.linkClaimRegistry.put(userId, refreshed);

    // Get or create a durable pull consumer for this user.
    const consumer = await deps.workQueue.getOrCreateConsumer(userId);
    if (!consumer) {
      // NATS unavailable — tell daemon to retry
      return c.json({ error: "work queue unavailable" }, 503);
    }

    // Long-poll: wait up to POLL_TIMEOUT_MS for one work item.
    // consumer.fetch() returns Promise<ConsumerMessages> (a QueuedIterator<JsMsg>).
    // The `expires` option is the server-side timeout in ms (min 1000 ms).
    // We iterate with for-await; the iterator ends when the fetch window expires
    // with no messages (yields nothing) or when a message is delivered.
    const messages = await consumer.fetch({
      max_messages: 1,
      expires: POLL_TIMEOUT_MS,
    });

    for await (const msg of messages) {
      // ACK-ON-DELIVERY: the daemon is responsible for completing the run.
      // If the daemon crashes, the item is NOT redelivered in Phase B —
      // the progress-staleness sweeper handles recovery in a later phase.
      msg.ack();
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(msg.data));
      } catch {
        console.warn("[LinkWork] failed to parse work item, discarding");
        return c.body(null, 204);
      }
      return c.json(parsed);
    }

    // Poll window expired — no work available
    return c.body(null, 204);
  });

  return app;
}
