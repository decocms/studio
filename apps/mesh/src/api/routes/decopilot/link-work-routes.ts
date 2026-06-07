/**
 * Work long-poll endpoint for pull-transport daemons (spec §3.2).
 *
 * GET /api/links/work
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
 *
 * Claim headers (sent by the daemon on every poll, mirrors the hello frame):
 *   x-link-capabilities  — comma-separated capability strings (e.g. "claude-code")
 *   x-link-machine-id    — stable machine identifier
 *   x-link-cli-version   — daemon CLI version string
 *   x-link-preview-port  — local preview server port (numeric string)
 */
import { Hono } from "hono";
import type { Env } from "../../hono-env";
import type { LinkClaimRegistry, LinkClaim } from "@/links/link-claim-registry";
import { capabilitiesArraySchema } from "@/links/protocol/schemas";
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

    // Read daemon-advertised fields from request headers (mirrors the hello frame
    // on the WS path). These are sent by the daemon on every poll so the claim
    // always reflects the daemon's current state.
    const rawCapabilities = c.req.header("x-link-capabilities") ?? "";
    const capabilities = capabilitiesArraySchema.parse(
      rawCapabilities.length > 0 ? rawCapabilities.split(",") : [],
    );
    const machineId = c.req.header("x-link-machine-id") ?? `pull-${userId}`;
    const cliVersion = c.req.header("x-link-cli-version") ?? "pull";
    const previewPortRaw = c.req.header("x-link-preview-port");
    const previewPort =
      previewPortRaw !== undefined ? parseInt(previewPortRaw, 10) || 0 : 0;

    // Refresh presence claim — TTL re-arms on every put (spec §3.2).
    // Always merge the daemon-advertised capabilities so resolveDispatchTarget
    // can check them (empty capabilities caused the 409 for claude-code threads).
    const existing = await deps.linkClaimRegistry.get(userId);
    const refreshed: LinkClaim = existing
      ? {
          ...existing,
          capabilities,
          machineId,
          cliVersion,
          previewPort,
          connectedAt: Date.now(),
        }
      : {
          podId: `pull-${userId}`,
          machineId,
          cliVersion,
          previewPort,
          connectedAt: Date.now(),
          capabilities,
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

    // Stop the JetStream iterator when the HTTP client disconnects.
    // Without this, an aborted client (e.g. a presence-only call with a short
    // timeout) leaves a live server-side NATS fetch for up to POLL_TIMEOUT_MS.
    // If the gate publishes a work item during that window the orphaned handler
    // would ack+consume it, causing the daemon's next real poll to see nothing.
    const abortListener = () => {
      messages.stop();
    };
    const reqSignal = c.req.raw.signal;
    if (reqSignal) {
      if (reqSignal.aborted) {
        messages.stop();
      } else {
        reqSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

    try {
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
    } finally {
      if (reqSignal && !reqSignal.aborted) {
        reqSignal.removeEventListener("abort", abortListener);
      }
    }

    // Poll window expired — no work available
    return c.body(null, 204);
  });

  return app;
}
