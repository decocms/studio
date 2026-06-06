/**
 * Proxy-poll loop for the pull reverse-proxy channel (Phase C-bis S2).
 *
 * The desktop daemon is outbound-only, so the cluster cannot push the sandbox
 * control/events/vm-tools traffic to it. Instead the daemon long-polls
 * `GET /api/:org/links/proxy`; the cluster publishes one `RequestFrame` per
 * call (queue-group `link-proxy`). The daemon runs the request locally via
 * `controlHandler.handleStream` and streams the framed reply back to the
 * cluster as a `duplex:"half"` upload to `POST /api/:org/links/proxy/:reqId/stream`.
 *
 * Two invariants make this correct (both from the hardened plan §3b / §5):
 *
 *   1. CONTINUOUS-OVERLAP POLLING (landmine #5). Core NATS is no-op-if-no-
 *      subscriber: a request published into an unsubscribed gap is silently
 *      dropped → vm-tools hang → probeHealth fails → cold-spawn thrash. So the
 *      daemon keeps ≥2 GETs in flight at all times: when a GET returns a frame,
 *      it IMMEDIATELY re-issues a GET to restore the overlap (it does not wait
 *      for the prior request to finish). On a 204 timeout it re-issues too.
 *
 *   2. DETACHED PER-reqId DISPATCH (landmine #2). `/events` SSE never ends, so a
 *      serial "dequeue → run → re-poll" loop would deadlock all proxy traffic
 *      the moment one preview tab is open. Each dequeued frame is handed to a
 *      DETACHED handler; the loop re-polls without awaiting it.
 *
 * Encoding (landmine #9): body chunks are base64 end-to-end. `handleStream` now
 * yields raw upstream bytes; this loop base64-encodes them into `chunk` frames.
 *
 * Cancel: routed through the control-poll, NOT a direct NATS subscription (the
 * daemon can't subscribe). The cluster publishes `{type:"cancel_req",reqId}` to
 * `links.control.<userSub>`; `control-poller` calls `proxyAbortRegistry.abort`.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
import { exponentialBackoffWithJitter, sleep } from "@decocms/std";
import {
  encodeProxyReplyFrame,
  type ProxyReplyFrame,
} from "../api/routes/decopilot/link-proxy-frames";
import type { RequestFrame } from "../links/link-control-types";
import type { ControlHandler, StreamEvent } from "./control-handler";
import * as proxyAbortRegistry from "./proxy-abort-registry";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** Default number of GETs the daemon keeps in flight (≥2 — landmine #5). */
const DEFAULT_PROXY_CONCURRENCY = 2;

export interface ProxyPollerDeps {
  /** Fully-qualified base URL, e.g. "https://studio.deco.cx". */
  baseUrl: string;
  /** Org slug for the org-scoped routes /api/:org/links/proxy[/...]. */
  orgSlug: string;
  /**
   * Bearer token resolver. Called before each GET / reply-POST so a refreshed
   * token reaches every request (mirrors work-poller.ts's getAccessToken).
   */
  getAccessToken: () => Promise<string> | string;
  /** In-process control handler — proxies `/_sandbox/<handle>/*` to localhost. */
  controlHandler: ControlHandler;
  /** Abort signal (loop-wide). The loop exits cleanly when aborted. */
  signal: AbortSignal;
  /** Injected fetch implementation. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Number of overlapping GETs to keep in flight. Default 2 (≥2 required so the
   * queue-group always has a waiting subscriber — landmine #5).
   */
  concurrency?: number;
}

/**
 * Encode the raw upstream bytes a `raw-chunk` StreamEvent carries as a base64
 * `chunk` reply frame (landmine #9 — base64 end-to-end for binary safety).
 */
function chunkFrame(bytes: Uint8Array): ProxyReplyFrame {
  return { type: "chunk", data: Buffer.from(bytes).toString("base64") };
}

const encoder = new TextEncoder();

/**
 * Build the NDJSON reply body as a streaming `ReadableStream<Uint8Array>` driven
 * by `controlHandler.handleStream`. Each StreamEvent is mapped to a reply frame
 * and flushed as ONE NDJSON line the instant it is produced (no buffering —
 * mirrors handle-local-dispatch.ts's duplex upload). The terminal `end`/`error`
 * frame is appended when the iterator finishes/throws/aborts. The `signal`
 * cancels the upstream iteration (so cancel frees the SSE slot).
 */
export function buildReplyBody(
  controlHandler: ControlHandler,
  frame: RequestFrame,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  // Thread `signal` into handleStream so a cancel aborts the upstream fetch +
  // read (frees the SSE slot via acquireDispatch's release — landmine #3),
  // rather than waiting for the next upstream byte that an idle `/events` SSE
  // never sends.
  const iterable = controlHandler.handleStream(frame, signal);
  let iterator: AsyncIterator<StreamEvent> | null = null;

  const writeLine = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    f: ProxyReplyFrame,
  ): void => {
    controller.enqueue(encoder.encode(`${encodeProxyReplyFrame(f)}\n`));
  };

  return new ReadableStream<Uint8Array>({
    start() {
      iterator = iterable[Symbol.asyncIterator]();
    },
    async pull(controller) {
      try {
        const { value, done } = await iterator!.next();
        if (done) {
          // On cancel the generator returns quietly (its abort branch), so a
          // `done` after an abort is a cancellation, not a clean end. Emit the
          // matching terminal so the awaiting DispatchFn throws vs. returns.
          if (signal.aborted) {
            writeLine(controller, {
              type: "error",
              code: "cancelled",
              message: "proxy request cancelled",
            });
          } else {
            writeLine(controller, { type: "end" });
          }
          controller.close();
          return;
        }
        if (value.type === "headers") {
          writeLine(controller, {
            type: "headers",
            status: value.status,
            headers: value.headers,
          });
        } else {
          writeLine(controller, chunkFrame(value.data));
        }
      } catch (err) {
        // Upstream iteration threw (connect refused / body stream broke). The
        // generator's own abort branch returns quietly, so reaching here means
        // a genuine handler error — surface it as an error terminal.
        writeLine(controller, {
          type: "error",
          code: "handler_error",
          message: err instanceof Error ? err.message : String(err),
        });
        controller.close();
      }
    },
    async cancel() {
      // The reply POST connection dropped — stop pulling upstream so the
      // handler's `finally` (release()) runs.
      try {
        await iterator?.return?.();
      } catch {
        // ignore
      }
    },
  });
}

/**
 * Handle ONE dequeued RequestFrame: register a per-reqId AbortController, build
 * the streaming reply body from `handleStream`, and POST it (duplex upload) to
 * the cluster reply endpoint. Resolves when the reply POST settles. Never
 * throws — errors are logged so a detached invocation can't crash the loop.
 *
 * Module-local — `runProxyPollLoop` detaches it; the unit-testable seams are
 * `runOverlapScheduler` (scheduling) and `buildReplyBody` (framing).
 */
async function handleProxyRequest(
  frame: RequestFrame,
  deps: Pick<
    ProxyPollerDeps,
    "baseUrl" | "orgSlug" | "getAccessToken" | "controlHandler" | "fetchImpl"
  > & { signal: AbortSignal },
): Promise<void> {
  const fetcher = deps.fetchImpl ?? fetch;
  const reqId = frame.reqId;
  // Per-reqId AbortController — the control-poll cancel path aborts THIS one
  // (not the loop-wide signal). Combine with the loop signal so close() also
  // tears the request down.
  const reqAc = proxyAbortRegistry.register(reqId);
  const combined = AbortSignal.any([deps.signal, reqAc.signal]);

  try {
    let token: string;
    try {
      token = await deps.getAccessToken();
    } catch (err) {
      console.error(
        `[proxy-poller] getAccessToken failed for reqId=${reqId}`,
        err,
      );
      return;
    }

    const body = buildReplyBody(deps.controlHandler, frame, combined);
    const url = `${deps.baseUrl}/api/${deps.orgSlug}/links/proxy/${reqId}/stream`;

    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-ndjson",
        },
        body,
        // @ts-expect-error — `duplex: "half"` is required by the Fetch spec for
        // streaming request bodies; supported by Node/Bun/undici but not yet in
        // all TS DOM typings (see handle-local-dispatch.ts).
        duplex: "half",
        signal: combined,
      });
      if (!res.ok && res.status !== 204) {
        console.warn(
          `[proxy-poller] reply POST reqId=${reqId} → ${res.status}`,
        );
      }
    } catch (err) {
      if (combined.aborted) return; // expected on cancel/close
      console.error(`[proxy-poller] reply POST failed reqId=${reqId}`, err);
    }
  } finally {
    proxyAbortRegistry.unregister(reqId);
  }
}

/**
 * The overlap scheduler — the pure, HTTP-free core of the continuous-overlap
 * invariant (landmine #5 + #2). It keeps exactly `concurrency` `pollOnce` calls
 * in flight at all times; when one returns a frame it detaches `handle(frame)`
 * (NEVER awaits it) and re-issues a poll to restore the overlap. On a `null`
 * (204 timeout) it re-issues immediately. On a `pollOnce` rejection it backs off
 * (shared streak across slots) then re-issues. Resolves when `signal` aborts
 * and all in-flight polls have settled.
 *
 * Injecting `pollOnce` + `handle` + `backoff`/`wait` makes the invariant
 * testable without real fetch: a test drives frames through a fake `pollOnce`
 * and asserts ≥`concurrency` polls are always outstanding and `handle` is
 * detached (the loop re-polls before `handle` resolves).
 */
export interface OverlapSchedulerDeps {
  /** One long-poll. Returns a RequestFrame, or null on a 204 timeout. */
  pollOnce: () => Promise<RequestFrame | null>;
  /** Detached per-reqId handler. The scheduler never awaits its result. */
  handle: (frame: RequestFrame) => void;
  /** Number of polls to keep in flight (≥1; ≥2 in production — landmine #5). */
  concurrency: number;
  /** Loop-wide abort signal. */
  signal: AbortSignal;
  /** Backoff after a poll rejection. Defaults to std exponential+jitter. */
  backoff?: (streak: number) => number;
  /** Cancellable wait. Defaults to `sleep(ms,{signal})`. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export async function runOverlapScheduler(
  deps: OverlapSchedulerDeps,
): Promise<void> {
  const { pollOnce, handle, signal } = deps;
  const concurrency = Math.max(1, deps.concurrency);
  const backoff =
    deps.backoff ??
    ((streak: number) =>
      exponentialBackoffWithJitter(
        MAX_DELAY_MS,
        BASE_DELAY_MS,
        streak,
        2,
        0.5,
      ));
  const wait =
    deps.wait ?? ((ms, s) => sleep(ms, { signal: s }).catch(() => {}));

  let errorStreak = 0;

  // One slot = one perpetually-recurring poll. Each slot re-arms itself the
  // instant its poll settles, so the count of outstanding polls never drops
  // below `concurrency` while the loop is alive (the no-gap guarantee).
  const slot = async (): Promise<void> => {
    while (!signal.aborted) {
      let frame: RequestFrame | null;
      try {
        frame = await pollOnce();
        errorStreak = 0;
      } catch (err) {
        if (signal.aborted) return;
        console.error("[proxy-poller] poll error", err);
        const delay = backoff(errorStreak);
        errorStreak++;
        await wait(delay, signal);
        continue;
      }
      if (signal.aborted) return;
      if (frame === null) continue; // 204 timeout — re-poll immediately.
      // DETACHED dispatch (landmine #2): hand off without awaiting, then loop
      // back to re-poll IMMEDIATELY so this slot restores the overlap.
      try {
        handle(frame);
      } catch (err) {
        // `handle` should be detached/non-throwing; guard anyway so one bad
        // dispatch can't kill the slot.
        console.error("[proxy-poller] handle threw (swallowed)", err);
      }
    }
  };

  const slots: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) slots.push(slot());
  await Promise.all(slots);
}

/**
 * Run the proxy-poll loop with continuous overlap. Resolves when `signal` is
 * aborted and all in-flight polls have settled.
 *
 * Wires the real HTTP `pollOnce` (GET /api/:org/links/proxy) and the detached
 * `handle` (handleProxyRequest) into `runOverlapScheduler`.
 */
export async function runProxyPollLoop(deps: ProxyPollerDeps): Promise<void> {
  const fetcher = deps.fetchImpl ?? fetch;
  const concurrency = deps.concurrency ?? DEFAULT_PROXY_CONCURRENCY;
  const url = `${deps.baseUrl}/api/${deps.orgSlug}/links/proxy`;

  const pollOnce = async (): Promise<RequestFrame | null> => {
    const token = await deps.getAccessToken();
    const res = await fetcher(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: deps.signal,
    });
    if (res.status === 204) return null; // poll window expired with no work.
    if (res.status !== 200) {
      // Drain the body so the connection can be reused, then signal a retry.
      try {
        await res.text();
      } catch {
        // ignore
      }
      throw new Error(`proxy poll unexpected status ${res.status}`);
    }
    const raw = (await res.json()) as RequestFrame;
    if (
      !raw ||
      raw.type !== "request" ||
      typeof raw.reqId !== "string" ||
      typeof raw.method !== "string" ||
      typeof raw.path !== "string"
    ) {
      throw new Error("proxy poll: malformed RequestFrame");
    }
    return raw;
  };

  const handle = (frame: RequestFrame): void => {
    // Detached — fire-and-forget. handleProxyRequest never throws.
    void handleProxyRequest(frame, {
      baseUrl: deps.baseUrl,
      orgSlug: deps.orgSlug,
      getAccessToken: deps.getAccessToken,
      controlHandler: deps.controlHandler,
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    });
  };

  await runOverlapScheduler({
    pollOnce,
    handle,
    concurrency,
    signal: deps.signal,
  });
}
