/**
 * `POST /_sandbox/dispatch` + `DELETE /_sandbox/runs/:runId`.
 *
 * Authenticated by the daemon's bearer `daemonToken` (see `../auth`). The
 * cluster-side caller is `remoteDispatch` in
 * `apps/mesh/src/harnesses/remote-dispatch.ts`, proxied to the daemon by
 * the link daemon's control handler over loopback; both sides parse SSE
 * events from `dispatchSSEEventSchema`.
 *
 * Dispatch flow:
 *   1. Verify the bearer token.
 *   2. Decode + Zod-validate the body.
 *   3. Refuse if the runId is currently tombstoned (cancel-before-dispatch).
 *   4. Register an AbortController keyed by runId so a later DELETE
 *      aborts the in-flight harness loop.
 *   5. Stream `UIMessageChunk` from the harness as SSE
 *      `data: {"type":"ui-message-chunk","chunk":...}\n\n` events.
 *   6. Wrap any harness throw as `{type:"error", code, message}` then
 *      always emit `{type:"done"}` and close the stream.
 *
 * Cancel is idempotent (204 for unknown ids) and writes a 60s tombstone
 * so a dispatch racing in after the cancel still resolves to 410 Gone.
 */

import { parseMessagesRef } from "../../../../apps/mesh/src/harnesses/offload-messages";
import {
  dispatchSSEEventSchema,
  harnessStreamInputSchema,
  type DispatchSSEEvent,
} from "../../../../apps/mesh/src/links/protocol";
import type { LinkErrorCode } from "../../../../apps/mesh/src/links/protocol/error-codes";
import { requireToken } from "../auth";
import { fetchOffloadedMessages } from "./offload-fetch";

/** Minimal harness shape the dispatch route needs. Decoupled from the
 *  harness factories in `apps/mesh/src/harnesses` so the route file (and
 *  its tests) don't need to import a full harness factory. The daemon's
 *  `lookupHarness` injection adapts a real factory to this shape. */
export interface DispatchHarness {
  stream: () => AsyncIterable<unknown>;
}

export interface DispatchDeps {
  /** Bearer daemon token. The link daemon's control handler injects it as
   *  `Authorization: Bearer <daemonToken>` when proxying over loopback;
   *  in-cluster docker uses the same scheme. */
  daemonToken: string;
  /** Look up a harness factory by id and instantiate it for this run.
   *  Throws if the id is unknown. */
  lookupHarness: (id: string, input: unknown) => DispatchHarness;
  /** Hostnames an offloaded `messagesRef.url` is allowed to resolve to.
   *  Comes from daemon boot config (NEVER from the request frame) — that is
   *  the SSRF guarantee. Empty (the default) fails CLOSED: every offload
   *  fetch is rejected. */
  allowedHosts: string[];
  /** Dev escape hatch: allow `http://` loopback offload refs (same-host
   *  MinIO). false in production. */
  allowSameHostDev: boolean;
}

export interface CancelDeps {
  /** See `DispatchDeps.daemonToken`. */
  daemonToken: string;
}

const TOMBSTONE_MS = 60_000;

/** AbortController per active dispatch, keyed by runId. The cancel route
 *  signals through this so the harness's `for await` loop breaks. */
const activeRuns = new Map<string, AbortController>();

/** Recently-cancelled runIds. A dispatch that arrives within
 *  `TOMBSTONE_MS` of a cancel is rejected with 410 Gone — this resolves
 *  the cancel-before-dispatch race that otherwise leaves an orphan
 *  harness running on the desktop. */
const tombstones = new Map<string, number>();

/** Test-visible hook to reset module state between tests. The harness
 *  tests in this file share the module-scoped maps; resetting prevents
 *  cross-test pollution. */
export function resetDispatchStateForTests(): void {
  activeRuns.clear();
  tombstones.clear();
}

/** SSE response headers. Shared by both the synchronous (non-offload) and the
 *  deferred (offload) paths so the cluster's dispatcher sees the identical
 *  first frame regardless of which path served the request. */
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-store",
  connection: "keep-alive",
} as const;

/** Drive a harness's stream into an SSE controller. Reused verbatim by both
 *  paths so chunk relaying / abort handling / error wrapping / `done` framing
 *  stay identical. Always emits `done` and closes the controller; never hangs.
 *  Clears the `activeRuns` entry in `finally`. */
async function streamHarnessRun(
  controller: ReadableStreamDefaultController<Uint8Array>,
  write: (event: DispatchSSEEvent) => void,
  harness: DispatchHarness,
  ctrl: AbortController,
  harnessId: string,
  runId: string,
  state?: { closed: boolean },
): Promise<void> {
  let chunkCount = 0;
  try {
    for await (const chunk of harness.stream()) {
      if (ctrl.signal.aborted || state?.closed) break;
      chunkCount++;
      write({ type: "ui-message-chunk", chunk });
    }
    console.log(
      `[dispatch] done harness=${harnessId} runId=${runId} chunks=${chunkCount} aborted=${ctrl.signal.aborted}`,
    );
  } catch (err) {
    console.error(
      `[dispatch] harness crashed harness=${harnessId} runId=${runId} chunks=${chunkCount}:`,
      err,
    );
    const code: LinkErrorCode = "harness_crashed";
    write({
      type: "error",
      code,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    write({ type: "done" });
    activeRuns.delete(runId);
    // Guarded: the SSE consumer may have cancelled (reader disconnect), which
    // closes the controller out from under us — closing it again throws.
    if (!state?.closed) {
      try {
        controller.close();
      } catch {
        // Already closed by a consumer cancel — nothing to do.
      }
    }
  }
}

export async function handleDispatchRequest(
  req: Request,
  deps: DispatchDeps,
): Promise<Response> {
  const denied = requireToken(req, deps.daemonToken);
  if (denied) return denied;

  const body = await req.text();

  let parsed: { harnessId: unknown; input: unknown };
  try {
    parsed = JSON.parse(body) as { harnessId: unknown; input: unknown };
  } catch {
    return new Response(JSON.stringify({ error: "bad_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (typeof parsed.harnessId !== "string") {
    return new Response(JSON.stringify({ error: "missing_harness_id" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const harnessId = parsed.harnessId;

  const encoder = new TextEncoder();

  // Offload path: `input.messages` was stripped on the cluster side and sent
  // by reference. We CANNOT validate/look up/run before fetching it back — and
  // that fetch may be slow. The cluster's dispatcher arms a 30s "first reply"
  // timer keyed on the daemon's response headers, so we MUST return the SSE
  // 200 immediately and move EVERY slow/failable step (fetch → splice →
  // validate → tombstone → lookup → run) inside `start()`, which runs only
  // after this Response is handed back. Any failure becomes an SSE `error`
  // event followed by `done` — we never hang and never emit a late 4xx.
  const messagesRef = parseMessagesRef(parsed);
  if (messagesRef) {
    // Created up front (not mid-`start()`) so the stream's `cancel()` can reach
    // them when the SSE consumer disconnects — mirrors the non-offload path:
    // `streamState.closed` + `ctrl.signal.aborted` guard every `write`, and a
    // reader cancel aborts the run instead of letting the harness enqueue onto a
    // closed controller (which throws ERR_INVALID_STATE → bogus harness_crashed
    // → cluster re-dispatch storm).
    const streamState = { closed: false };
    const ctrl = new AbortController();
    const sseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // write captures controller — cannot hoist above the stream
        const write = (event: DispatchSSEEvent): void => {
          if (streamState.closed || ctrl.signal.aborted) return;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          } catch {
            // Consumer disconnected between the guard check and the enqueue.
            streamState.closed = true;
          }
        };
        const fail = (code: string, message: string) => {
          write({ type: "error", code, message });
          write({ type: "done" });
          if (!streamState.closed) {
            try {
              controller.close();
            } catch {
              // Already closed by a consumer cancel — nothing to do.
            }
          }
        };

        // 1. Fetch the offloaded messages. SSRF-guarded by daemon config
        //    (allowedHosts / allowSameHostDev), NEVER by the request frame.
        let messages: unknown;
        try {
          messages = await fetchOffloadedMessages(messagesRef.url, {
            allowedHosts: deps.allowedHosts,
            allowSameHostDev: deps.allowSameHostDev,
            expectedSha256: messagesRef.sha256,
          });
        } catch (err) {
          console.error(
            `[dispatch] offload fetch failed harness=${harnessId} url=${messagesRef.url}:`,
            err,
          );
          const code: LinkErrorCode = "offload_fetch_failed";
          fail(code, err instanceof Error ? err.message : String(err));
          return;
        }

        // 2. Splice the fetched messages back into the input envelope, then
        //    run it through the SAME schema the non-offload path uses.
        const baseInput =
          parsed.input !== null && typeof parsed.input === "object"
            ? (parsed.input as Record<string, unknown>)
            : {};
        const merged = { ...baseInput, messages };
        const inputParse = harnessStreamInputSchema.safeParse(merged);
        if (!inputParse.success) {
          const code: LinkErrorCode = "bad_input";
          fail(code, inputParse.error.message);
          return;
        }
        const input = inputParse.data;

        // 3. Tombstone check — a cancel may have landed first. Surface it as a
        //    terminal error rather than starting a doomed harness.
        const tombstoneExpiry = tombstones.get(input.runId);
        if (tombstoneExpiry && tombstoneExpiry > Date.now()) {
          const code: LinkErrorCode = "tombstoned";
          fail(code, `runId ${input.runId} was cancelled`);
          return;
        } else if (tombstoneExpiry) {
          tombstones.delete(input.runId);
        }

        activeRuns.set(input.runId, ctrl);

        console.log(
          `[dispatch] received (offload) harness=${harnessId} runId=${input.runId} threadId=${input.threadId} bytes=${messagesRef.bytes}`,
        );

        // 4. Look up + run.
        let harness: DispatchHarness;
        try {
          harness = deps.lookupHarness(harnessId, input);
        } catch (err) {
          activeRuns.delete(input.runId);
          console.error(
            `[dispatch] lookupHarness failed harness=${harnessId} runId=${input.runId}:`,
            err,
          );
          const code: LinkErrorCode = "unknown_harness";
          fail(code, err instanceof Error ? err.message : String(err));
          return;
        }

        await streamHarnessRun(
          controller,
          write,
          harness,
          ctrl,
          harnessId,
          input.runId,
          streamState,
        );
      },
      cancel() {
        // The SSE consumer disconnected (reader cancel) — e.g. the user
        // navigated away or the link WS was torn down mid-run. Abort the run so
        // the harness loop stops pulling chunks instead of enqueuing onto the
        // now-closed controller. Mirrors the non-offload path + DELETE
        // /_sandbox/runs/:id. Safe even before `activeRuns.set`: aborting `ctrl`
        // early makes `streamHarnessRun` exit immediately once it runs.
        streamState.closed = true;
        ctrl.abort();
      },
    });

    return new Response(sseStream, { status: 200, headers: SSE_HEADERS });
  }

  // Non-offload path — unchanged: synchronous validate + 4xx + tombstone +
  // lookup, then stream.
  const inputParse = harnessStreamInputSchema.safeParse(parsed.input);
  if (!inputParse.success) {
    return new Response(
      JSON.stringify({ error: "bad_input", detail: inputParse.error.message }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const input = inputParse.data;

  // Tombstone check — a cancel landed before this dispatch did. Decline
  // and let the cluster surface a clear cancellation instead of starting
  // a CLI process that will be immediately torn down.
  const tombstoneExpiry = tombstones.get(input.runId);
  if (tombstoneExpiry && tombstoneExpiry > Date.now()) {
    return new Response(JSON.stringify({ error: "tombstoned" }), {
      status: 410,
      headers: { "content-type": "application/json" },
    });
  } else if (tombstoneExpiry) {
    // Expired entry — clean up opportunistically.
    tombstones.delete(input.runId);
  }

  const ctrl = new AbortController();
  activeRuns.set(input.runId, ctrl);

  console.log(
    `[dispatch] received harness=${harnessId} runId=${input.runId} threadId=${input.threadId}`,
  );

  let harness: DispatchHarness;
  try {
    harness = deps.lookupHarness(harnessId, input);
  } catch (err) {
    activeRuns.delete(input.runId);
    console.error(
      `[dispatch] lookupHarness failed harness=${harnessId} runId=${input.runId}:`,
      err,
    );
    return new Response(
      JSON.stringify({
        error: "unknown_harness",
        detail: err instanceof Error ? err.message : String(err),
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // Set once the SSE consumer goes away (reader cancel) or the run is aborted.
  // Guards every `write` so a harness that keeps producing chunks after the
  // client disconnected can't `enqueue` on a closed controller — that throws
  // `ERR_INVALID_STATE: Controller is already closed`, which surfaced as a
  // bogus `harness_crashed` and triggered a cluster re-dispatch storm. Shared
  // (object, not a bare `let`) so `streamHarnessRun` and `cancel()` both read
  // and flip it.
  const streamState = { closed: false };
  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // write captures controller — cannot hoist above the stream
      const write = (event: DispatchSSEEvent): void => {
        if (streamState.closed || ctrl.signal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Consumer disconnected between the guard check and the enqueue.
          streamState.closed = true;
        }
      };
      await streamHarnessRun(
        controller,
        write,
        harness,
        ctrl,
        harnessId,
        input.runId,
        streamState,
      );
    },
    cancel() {
      // The SSE consumer (link daemon → cluster reverse-proxy → browser)
      // disconnected — e.g. the user navigated to another task or the link
      // WS stream was torn down mid-run. Abort the run so the harness
      // `for await` loop stops pulling chunks instead of spinning until it
      // writes to the now-closed controller. Mirrors DELETE /_sandbox/runs/:id.
      streamState.closed = true;
      ctrl.abort();
    },
  });

  return new Response(sseStream, { status: 200, headers: SSE_HEADERS });
}

export async function handleCancelRequest(
  req: Request,
  deps: CancelDeps,
): Promise<Response> {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/runs\/([^/]+)$/);
  if (!match) return new Response(null, { status: 404 });
  const runId = match[1]!;

  const denied = requireToken(req, deps.daemonToken);
  if (denied) return denied;

  const ctrl = activeRuns.get(runId);
  if (ctrl) ctrl.abort();
  tombstones.set(runId, Date.now() + TOMBSTONE_MS);

  // Idempotent: 204 whether or not the runId was active. This mirrors
  // the cluster's `remoteDispatch` cancel — it fires DELETE on consumer
  // abort regardless of whether the daemon ever saw the runId.
  return new Response(null, { status: 204 });
}

// Schema re-exports so the daemon's main handler can validate without
// reaching back into `apps/mesh/src/links/protocol` directly.
export { dispatchSSEEventSchema, harnessStreamInputSchema };
