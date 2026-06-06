/**
 * Pull reverse-proxy channel for desktop link daemons (Phase C-bis §3b).
 *
 * Replaces the WS reverse-proxy (`dispatcher.ts` + `ws-gateway.ts`) for the
 * sandbox control/events/vm-tools traffic that funnels through
 * `DesktopSandboxProvider.proxyDaemonRequest`. Two id-derived core-NATS
 * subjects re-express the WS subscription-interest routing behind a long-poll:
 *
 *   REQUEST leg  `links.proxy.req.<userSub>`   cluster → daemon (one RequestFrame)
 *   REPLY leg    `links.proxy.reply.<reqId>`   daemon → cluster (NDJSON stream)
 *   CANCEL leg   `links.proxy.cancel.<reqId>`  cluster → daemon (abort)
 *
 * The reqId is the SOLE correlation key — the reply subject is derived purely
 * from the URL `:reqId` param, so the POST that carries the reply can land on
 * ANY pod and NATS still routes every frame to the pod awaiting that reqId.
 * No per-pod in-memory inflight map; no LB affinity assumption.
 *
 * DORMANT (Phase C-bis S1): the routes are mounted but no production caller
 * holds the GET open and `createProxyDispatch` is not yet injected into the
 * provider (that is S3). See `local-link-pull-inversion-phase-c-bis-plan.md`.
 *
 * Wire framing: NDJSON — see `link-proxy-frames.ts` for the authoritative spec
 * that the daemon side (S2) must match.
 */
import { Hono } from "hono";
import type { NatsConnection } from "nats";
import type { Env } from "../../hono-env";
import type { RequestFrame } from "@/links/link-control-types";
import type { DispatchChunk, DispatchFn } from "@/links/link-dispatch-types";
import {
  decodeProxyReplyFrame,
  splitNdjsonLines,
  type ProxyReplyFrame,
} from "./link-proxy-frames";

// Just under a typical 30 s HTTP gateway timeout (mirrors link-control-routes).
const POLL_TIMEOUT_MS = 28_000;

// Shared queue group for the request leg. The daemon holds MULTIPLE overlapping
// GETs open (continuous-overlap, S2) to avoid an unsubscribed gap; a plain
// core-NATS subscription would fan each request out to ALL of them
// (double-execution). A queue group delivers each published request to exactly
// ONE waiting GET (landmine #5 — the cluster half of the no-gap guarantee).
const REQUEST_QUEUE_GROUP = "link-proxy";

const SUBJECT_PREFIX = "links.proxy";

function isSafeSubjectToken(id: string): boolean {
  return id.length > 0 && !/[.*>\s]/.test(id);
}

export function buildRequestSubject(userSub: string): string {
  return `${SUBJECT_PREFIX}.req.${userSub}`;
}

export function buildReplySubject(reqId: string): string {
  return `${SUBJECT_PREFIX}.reply.${reqId}`;
}

export function buildCancelSubject(reqId: string): string {
  return `${SUBJECT_PREFIX}.cancel.${reqId}`;
}

/**
 * Minimal NATS surface the cluster-side `DispatchFn` adapter needs.
 *
 * `subscribe` returns an unsubscribe function and delivers raw message bytes to
 * the callback; the adapter derives the reply subject purely from the reqId, so
 * no inbox/createInbox is required (unlike the WS `DispatcherNatsAdapter`).
 */
export interface ProxyNatsAdapter {
  publish(subject: string, data: Uint8Array): void;
  subscribe(subject: string, onMessage: (data: Uint8Array) => void): () => void;
}

export interface LinkProxyDeps {
  /** Native NATS connection getter (queue-group subscriptions need it). */
  getConnection: () => NatsConnection | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createLinkProxyRoutes(deps: LinkProxyDeps) {
  const app = new Hono<Env>();

  // ── REQUEST leg: the long-poll the daemon holds open ─────────────────────
  app.get("/links/proxy", async (c) => {
    const ctx = c.get("meshContext");
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    if (!isSafeSubjectToken(userId)) {
      return c.json({ error: "invalid user id" }, 400);
    }

    const nc = deps.getConnection();
    if (!nc) return c.json({ error: "proxy channel unavailable" }, 503);

    const subject = buildRequestSubject(userId);
    // Queue group + max:1 — each published RequestFrame goes to exactly ONE of
    // the daemon's overlapping GETs (landmine #5).
    const sub = nc.subscribe(subject, {
      queue: REQUEST_QUEUE_GROUP,
      max: 1,
    });

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

    try {
      const result = await Promise.race([
        (async (): Promise<string | null> => {
          for await (const msg of sub) {
            // The RequestFrame is published verbatim as JSON bytes; return it
            // as-is (the daemon validates it against its RequestFrame shape).
            return decoder.decode(msg.data);
          }
          return null; // unsubscribed externally
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
        // Re-emit as JSON. Parse-then-stringify would re-validate but also lose
        // forward-compatible fields; the daemon owns validation, so pass through.
        return c.body(result, 200, { "content-type": "application/json" });
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

  // ── REPLY leg: streaming NDJSON upload, republished frame-by-frame ────────
  app.post("/links/proxy/:reqId/stream", async (c) => {
    const ctx = c.get("meshContext");
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    const reqId = c.req.param("reqId");
    if (!isSafeSubjectToken(reqId)) {
      return c.json({ error: "invalid reqId" }, 400);
    }

    const nc = deps.getConnection();
    if (!nc) return c.json({ error: "proxy channel unavailable" }, 503);

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "missing body" }, 400);

    const replySubject = buildReplySubject(reqId);

    // Stream-consume the NDJSON body frame-by-frame WITHOUT buffering (landmine
    // #1) and core-NATS-publish each decoded frame to the reply subject. NEVER
    // `await c.req.text()` — the `/events` SSE reply never ends and would hang.
    // The headers frame is published before any chunk because the daemon emits
    // it first and we publish in arrival order.
    try {
      for await (const line of splitNdjsonLines(body)) {
        let frame: ProxyReplyFrame;
        try {
          frame = decodeProxyReplyFrame(line);
        } catch (err) {
          // A malformed frame is fatal for this reply: surface an error frame
          // to the awaiter rather than silently dropping it.
          publishReplyFrame(nc, replySubject, {
            type: "error",
            code: "bad_frame",
            message: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: "bad frame" }, 400);
        }
        publishReplyFrame(nc, replySubject, frame);
      }
      // Clean body end. The daemon is expected to send its own terminal
      // `end`/`error` frame; if it didn't (e.g. truncated stream that still
      // closed cleanly without a terminal), we don't synthesize one here —
      // S5's presence-expiry fanout is the backstop for a vanished daemon.
      return c.body(null, 204);
    } catch (err) {
      // Landmine #8 (POST-drop half): the upload connection broke mid-stream.
      // Publish an error frame so the awaiting DispatchFn throws instead of
      // hanging forever (full presence-expiry 502 fanout is S5).
      publishReplyFrame(nc, replySubject, {
        type: "error",
        code: "reply_stream_dropped",
        message: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "reply stream dropped" }, 500);
    }
  });

  return app;
}

function publishReplyFrame(
  nc: NatsConnection,
  subject: string,
  frame: ProxyReplyFrame,
): void {
  try {
    nc.publish(subject, encoder.encode(JSON.stringify(frame)));
  } catch {
    // Best-effort: a publish failure (e.g. NATS down) can't be recovered here;
    // the awaiter's own drop/timeout backstops (S5) handle it.
  }
}

export interface CreateProxyDispatchDeps {
  nats: ProxyNatsAdapter;
}

/**
 * Cluster-side `DispatchFn` over the pull reverse-proxy channel — the drop-in
 * replacement for `createDispatcher`'s return that S3 will inject into
 * `DesktopSandboxProvider` (proxyDaemonRequest / dispatchJson / probeHealth).
 *
 * For each call:
 *   1. Generate a reqId.
 *   2. SUBSCRIBE to `links.proxy.reply.<reqId>` BEFORE publishing the request
 *      (no first-frame race).
 *   3. PUBLISH the RequestFrame (carrying that reqId) to
 *      `links.proxy.req.<userSub>`.
 *   4. Yield decoded `DispatchChunk`s from the reply subscription until a
 *      terminal `end` (return) or `error` (throw) frame.
 *   5. On `opts.signal` abort, publish to `links.proxy.cancel.<reqId>` and stop.
 *
 * DORMANT (S1): exported for S3 to wire; no production caller yet.
 */
export function createProxyDispatch(deps: CreateProxyDispatchDeps): DispatchFn {
  return function proxyDispatch(userSub, req, opts) {
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<DispatchChunk> {
        // Fast-path: an already-aborted signal would never fire the listener
        // (the abort event has already been dispatched).
        if (opts?.signal?.aborted) {
          throw new Error("dispatch aborted");
        }
        if (!isSafeSubjectToken(userSub)) {
          throw new Error("dispatch: invalid userSub");
        }

        const reqId = crypto.randomUUID();
        const replySubject = buildReplySubject(reqId);

        const queue: ProxyReplyFrame[] = [];
        let resolve: (() => void) | null = null;
        let done = false;
        let error: Error | null = null;

        const wake = (): void => {
          const r = resolve;
          resolve = null;
          r?.();
        };

        // SUBSCRIBE BEFORE PUBLISH — guarantees we don't miss the first frame.
        const unsubscribe = deps.nats.subscribe(replySubject, (data) => {
          if (done) return;
          try {
            queue.push(decodeProxyReplyFrame(decoder.decode(data)));
          } catch (err) {
            error = err instanceof Error ? err : new Error(String(err));
            done = true;
          }
          wake();
        });

        let cleanedUp = false;
        const cleanup = (): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          done = true;
          try {
            unsubscribe();
          } catch {
            // ignore
          }
        };

        const onAbort = (): void => {
          deps.nats.publish(
            buildCancelSubject(reqId),
            encoder.encode(JSON.stringify({ type: "cancel", reqId })),
          );
          error = new Error("dispatch aborted");
          cleanup();
          wake();
        };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });

        // Publish the RequestFrame (carrying reqId) AFTER the reply sub is live.
        const requestFrame: RequestFrame = {
          type: "request",
          reqId,
          method: req.method,
          path: req.path,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
        };

        try {
          deps.nats.publish(
            buildRequestSubject(userSub),
            encoder.encode(JSON.stringify(requestFrame)),
          );
        } catch (err) {
          opts?.signal?.removeEventListener("abort", onAbort);
          cleanup();
          throw err instanceof Error ? err : new Error(String(err));
        }

        try {
          while (!done) {
            if (error) throw error;
            if (queue.length === 0) {
              await new Promise<void>((res) => {
                resolve = res;
              });
              if (error) throw error;
              continue;
            }
            const frame = queue.shift()!;
            if (frame.type === "chunk") {
              yield { data: frame.data };
            } else if (frame.type === "headers") {
              yield {
                headers: { status: frame.status, headers: frame.headers },
              };
            } else if (frame.type === "end") {
              return;
            } else if (frame.type === "error") {
              throw new Error(`${frame.code}: ${frame.message}`);
            }
          }
          if (error) throw error;
        } finally {
          opts?.signal?.removeEventListener("abort", onAbort);
          cleanup();
        }
      },
    };
  };
}
