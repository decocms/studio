/**
 * Control long-poll endpoint for pull-transport daemons (Phase C).
 *
 * GET /api/:org/links/control
 *
 * The daemon holds this connection continuously waiting for cluster-side
 * control frames (e.g. cancel). Each poll cycle:
 *   1. Subscribes to `links.control.<userId>` on core NATS.
 *   2. Waits up to POLL_TIMEOUT_MS for the next frame.
 *   3. Returns 200 with the decoded ControlFrame JSON when a frame arrives.
 *   4. Returns 204 if the poll window expires with no frame.
 *
 * Cancel correctness: the durable `cancel_requested_at` flag (set by the
 * cancel endpoint) is the authoritative correctness path. This route is the
 * low-latency notification channel — if NATS is unavailable or the frame
 * is lost, the daemon will observe the cancel via the ingest 409 backstop.
 */
import { Hono } from "hono";
import { decodeControlFrame } from "./control-frames";
import type { Env } from "../../hono-env";
import type { NatsConnection } from "nats";

export interface LinkControlDeps {
  getConnection: () => NatsConnection | null;
}

// Just under a typical 30 s HTTP gateway timeout (mirrors link-work-routes.ts).
const POLL_TIMEOUT_MS = 28_000;

export function createLinkControlRoutes(deps: LinkControlDeps) {
  const app = new Hono<Env>();

  app.get("/links/control", async (c) => {
    const ctx = c.get("meshContext");
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    if (/[.*>\s]/.test(userId)) {
      return c.json({ error: "invalid user id" }, 400);
    }

    const nc = deps.getConnection();
    if (!nc) {
      // NATS unavailable — tell daemon to retry
      return c.json({ error: "control channel unavailable" }, 503);
    }

    const subject = `links.control.${userId}`;
    const sub = nc.subscribe(subject, { max: 1 });
    const decoder = new TextDecoder();

    // Stop the subscription when the HTTP client disconnects.
    const abortListener = () => {
      try {
        sub.unsubscribe();
      } catch {
        // ignore
      }
    };
    const reqSignal = c.req.raw.signal;
    if (reqSignal) {
      if (reqSignal.aborted) {
        sub.unsubscribe();
        return c.body(null, 204);
      }
      reqSignal.addEventListener("abort", abortListener, { once: true });
    }

    // Use a race between the NATS subscription iterator and a timeout.
    try {
      const result = await Promise.race([
        (async (): Promise<string | null> => {
          for await (const msg of sub) {
            try {
              const frame = decodeControlFrame(decoder.decode(msg.data));
              return JSON.stringify(frame);
            } catch {
              console.warn(
                "[LinkControl] failed to decode control frame, ignoring",
              );
            }
          }
          return null; // subscription drained (unsubscribed externally)
        })(),
        new Promise<null>((resolve) => {
          setTimeout(() => {
            try {
              sub.unsubscribe();
            } catch {
              // ignore
            }
            resolve(null);
          }, POLL_TIMEOUT_MS);
        }),
      ]);

      if (result !== null) {
        return c.json(JSON.parse(result));
      }
      return c.body(null, 204);
    } finally {
      if (reqSignal && !reqSignal.aborted) {
        reqSignal.removeEventListener("abort", abortListener);
      }
      try {
        sub.unsubscribe();
      } catch {
        // ignore double-unsubscribe
      }
    }
  });

  return app;
}
