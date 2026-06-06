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
 *   CANCEL leg   `links.control.<userSub>`     cluster → daemon (cancel_req frame)
 *
 * The CANCEL leg rides the EXISTING control channel (a `cancel_req` control
 * frame carrying the reqId), NOT a dedicated `links.proxy.cancel.*` subject: the
 * outbound-only daemon cannot subscribe to a per-reqId subject, but it already
 * holds the control long-poll open. The daemon's control-poll forwards the
 * reqId to its proxy-abort-registry (Phase C-bis S2).
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
import type { LinkClaimRegistry } from "@/links/link-claim-registry";
import type { RequestFrame } from "@/links/link-control-types";
import type { DispatchChunk, DispatchFn } from "@/links/link-dispatch-types";
import { encodeControlFrame } from "./control-frames";
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

/** Control subject the daemon's control-poll holds open (cancel rides this). */
export function buildControlSubject(userSub: string): string {
  return `links.control.${userSub}`;
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
  /**
   * Link-claim presence registry. Only used by the NON-PRODUCTION test-trigger
   * route (`POST /links/proxy/_test/dispatch`) to wire the S5 fail-fast watcher
   * into its `createProxyDispatch` instance. Production `createProxyDispatch`
   * wiring lives in `app.ts`; this is optional so non-NATS test setups still
   * compile.
   */
  claimRegistry?: LinkClaimRegistry;
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

  // ── TEST-ONLY trigger: drive a real createProxyDispatch round-trip ────────
  //
  // The production caller of `createProxyDispatch` is `DesktopSandboxProvider`
  // (wired in S3, dormant behind `LINK_PROXY_TRANSPORT=pull`). To validate the
  // channel END-TO-END before the S6 cutover — cluster `createProxyDispatch`
  // → `links.proxy.req` → the GET above → a daemon simulator → the POST above
  // → `links.proxy.reply` → back to the awaiting caller — the e2e
  // (`link-proxy.spec.ts`) needs a server-side caller it can hit over HTTP.
  //
  // This route is that caller. It builds a fresh `createProxyDispatch` over the
  // SAME live NATS connection (identical wire behaviour to the shared instance)
  // and streams the decoded (base64→bytes) reply back to the HTTP client, so
  // the test can assert byte-exactness, incremental SSE streaming, and cancel.
  // It is NEVER mounted in production (`NODE_ENV==="production"` → 404) and is
  // scoped to the authenticated user's OWN proxy channel (no cross-user reach).
  if (process.env.NODE_ENV !== "production") {
    app.post("/links/proxy/_test/dispatch", async (c) => {
      const ctx = c.get("meshContext");
      const userId = ctx.auth?.user?.id;
      if (!userId) return c.json({ error: "unauthorized" }, 401);

      const nc = deps.getConnection();
      if (!nc) return c.json({ error: "proxy channel unavailable" }, 503);

      let payload: { method?: string; path?: string; body?: string };
      try {
        payload = (await c.req.json()) as typeof payload;
      } catch {
        return c.json({ error: "bad json" }, 400);
      }
      const method = payload.method ?? "GET";
      const path = payload.path ?? "/_sandbox/events";

      const dispatch = createProxyDispatch({
        nats: makeNatsAdapter(nc),
        ...(deps.claimRegistry
          ? {
              presence: {
                watch: (sub, listener) =>
                  deps.claimRegistry!.watch(sub, (claim) => listener(claim)),
              },
            }
          : {}),
      });

      const iter = dispatch(
        userId,
        {
          method,
          path,
          headers: {},
          ...(payload.body !== undefined ? { body: payload.body } : {}),
        },
        { signal: c.req.raw.signal },
      );
      const iterator = iter[Symbol.asyncIterator]();

      // Stream the decoded bytes back to the HTTP caller incrementally (no
      // buffering) so the test can observe per-chunk SSE relay. `data` is base64
      // on the channel (landmine #9); decode each chunk to raw bytes.
      let canceled = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (true) {
              const next = await iterator.next();
              if (canceled) return;
              if (next.done) {
                controller.close();
                return;
              }
              const chunk = next.value;
              if (chunk.data != null) {
                controller.enqueue(Buffer.from(chunk.data, "base64"));
                return;
              }
              // headers frame: ignore for the test body (status is asserted via
              // a header below would need pre-read; the test asserts on bytes).
            }
          } catch (err) {
            if (!canceled) controller.error(err);
          }
        },
        cancel() {
          canceled = true;
          void iterator.return?.();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    });
  }

  return app;
}

/**
 * Build a `ProxyNatsAdapter` over a live NATS connection. Mirrors the adapter
 * `app.ts` wires for the shared `createProxyDispatch` — extracted so the
 * test-trigger route can build an identical one.
 */
function makeNatsAdapter(nc: NatsConnection): ProxyNatsAdapter {
  return {
    publish(subject, data) {
      nc.publish(subject, data);
    },
    subscribe(subject, onMessage) {
      const sub = nc.subscribe(subject);
      void (async () => {
        for await (const m of sub) {
          try {
            onMessage(m.data);
          } catch {
            /* swallow — a bad subscriber must not kill the loop */
          }
        }
      })();
      return () => {
        try {
          sub.unsubscribe();
        } catch {
          /* */
        }
      };
    },
  };
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

/**
 * Minimal presence surface the `DispatchFn` adapter needs for the
 * daemon-vanished fail-fast (Phase C-bis S5, landmine #8). A structural subset
 * of `LinkClaimRegistry` — `watch(userSub, listener)` fires immediately with the
 * current claim (or `null`), then on every put/delete, and returns an
 * unsubscribe. The adapter only cares whether the claim is present, so the claim
 * payload is opaque (`unknown`).
 *
 * The presence claim (`studio_links` KV, 60 s TTL) is re-armed by the daemon's
 * work/control/proxy long-polls. If the daemon vanishes (stops polling) the
 * claim expires and the watcher fires `null`; the adapter aborts the in-flight
 * await and throws a 502-equivalent, mirroring `ws-gateway.ts`'s on-close error
 * fanout (ws-gateway.ts:424-451) — which used the WS close event as its liveness
 * signal where the pull channel has no socket, so the claim IS the liveness
 * signal. We deliberately reuse the registry's existing TTL/watch rather than
 * inventing a new idle timeout (the request body — e.g. `/events` SSE — has
 * legitimate long gaps, so a naive per-frame timeout would be wrong).
 */
export interface ProxyPresenceWatcher {
  watch(userSub: string, listener: (claim: unknown) => void): () => void;
}

export interface CreateProxyDispatchDeps {
  nats: ProxyNatsAdapter;
  /**
   * Optional presence watcher for the daemon-vanished fail-fast (S5). When
   * provided, the adapter aborts an in-flight request the moment the user's
   * link-claim presence disappears (expiry or explicit delete). When omitted
   * (e.g. NATS-less test setups), only the POST/GET-drop error-frame backstop
   * (S1) and caller-abort apply.
   */
  presence?: ProxyPresenceWatcher;
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
 *   5. On `opts.signal` abort, publish a `cancel_req` control frame (carrying
 *      the reqId) to `links.control.<userSub>` and stop. The daemon's
 *      control-poll forwards it to its proxy-abort-registry (S2).
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

        // Daemon-vanished fail-fast (landmine #8): watch the user's link-claim
        // presence. The claim's 60 s TTL is re-armed by the daemon's
        // work/control/proxy long-polls; if the daemon stops polling the claim
        // expires and the watcher fires `null`. We treat ANY `null` fire as the
        // daemon being gone (mirrors ws-gateway.ts's WS-close fanout: no socket
        // ⇒ dead) and abort the in-flight await with a 502-equivalent so
        // `runner.ts` rejects promptly instead of hanging on a reply that will
        // never arrive. The watcher fires immediately with the current value, so
        // a request to an already-absent daemon also fails fast (no waiting for
        // the POST/GET-drop backstop). We do NOT add an idle timeout — the
        // request body (`/events` SSE) has legitimate long gaps; presence is the
        // liveness signal, not inter-frame latency.
        let unwatchPresence: (() => void) | null = null;
        if (deps.presence) {
          unwatchPresence = deps.presence.watch(userSub, (claim) => {
            if (done) return;
            if (claim == null) {
              error = new Error(
                "link_unavailable: daemon presence lost (claim expired or disappeared)",
              );
              done = true;
              wake();
            }
          });
        }

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
          try {
            unwatchPresence?.();
          } catch {
            // ignore
          }
        };

        const onAbort = (): void => {
          // Publish a `cancel_req` control frame to the per-user control subject
          // (the channel the outbound-only daemon's control-poll holds open),
          // NOT a dedicated `links.proxy.cancel.*` subject the daemon can't
          // subscribe to. The daemon forwards the reqId to its
          // proxy-abort-registry, freeing the SSE slot (landmine #3).
          deps.nats.publish(
            buildControlSubject(userSub),
            encoder.encode(encodeControlFrame({ type: "cancel_req", reqId })),
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

        // If the presence watcher's initial fire already reported the daemon
        // absent, skip the publish (the subject has no subscriber — core NATS
        // would drop it) and let the loop below throw the fail-fast error.
        if (!done) {
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
