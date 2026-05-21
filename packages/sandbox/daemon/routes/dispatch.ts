/**
 * `POST /_decopilot_vm/dispatch` + `DELETE /_decopilot_vm/runs/:runId`.
 *
 * Authenticated by HMAC against the daemon's `linkSecret` (the same
 * value the cluster computed for the registered link entry — see
 * `apps/mesh/src/links/protocol`'s `signRequest` / `verifyRequest`). The
 * cluster-side caller is `remoteDispatch` in
 * `apps/mesh/src/harnesses/remote-dispatch.ts`; both sides parse SSE
 * events from `dispatchSSEEventSchema`.
 *
 * Dispatch flow:
 *   1. Verify HMAC.
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

import {
  dispatchSSEEventSchema,
  harnessStreamInputSchema,
  verifyRequest,
  type DispatchSSEEvent,
} from "../../../../apps/mesh/src/links/protocol";

/** Minimal harness shape the dispatch route needs. Decoupled from the
 *  harness factories in `apps/mesh/src/harnesses` so the route file (and
 *  its tests) don't need to import a full harness factory. The daemon's
 *  `lookupHarness` injection adapts a real factory to this shape. */
export interface DispatchHarness {
  stream: () => AsyncIterable<unknown>;
}

export interface DispatchDeps {
  /** Daemon-side bearer secret. Equals the link's `linkSecret` from the
   *  cluster's `LinkRegistry` — the cluster signs with it, the daemon
   *  verifies with it. */
  bearerSecret: string;
  /** Look up a harness factory by id and instantiate it for this run.
   *  Throws if the id is unknown. */
  lookupHarness: (id: string, input: unknown) => DispatchHarness;
  /** Nonce-replay guard. Returning `true` means the nonce was already
   *  used and should be rejected. The caller owns the cache (sized,
   *  TTL'd, etc.) — the route itself doesn't decide policy. */
  seenNonce: (nonce: string) => boolean;
}

export interface CancelDeps {
  bearerSecret: string;
  seenNonce: (nonce: string) => boolean;
}

const TOMBSTONE_MS = 60_000;

/** AbortController per active dispatch, keyed by runId. The cancel route
 *  signals through this so the harness's `for await` loop breaks. */
const activeRuns = new Map<string, AbortController>();

/** Recently-cancelled runIds. A dispatch that arrives within
 *  `TOMBSTONE_MS` of a cancel is rejected with 410 Gone — this resolves
 *  the cancel-before-dispatch race that otherwise leaves an orphan
 *  harness running on the laptop. */
const tombstones = new Map<string, number>();

/** Test-visible hook to reset module state between tests. The harness
 *  tests in this file share the module-scoped maps; resetting prevents
 *  cross-test pollution. */
export function resetDispatchStateForTests(): void {
  activeRuns.clear();
  tombstones.clear();
}

export async function handleDispatchRequest(
  req: Request,
  deps: DispatchDeps,
): Promise<Response> {
  const body = await req.text();
  const url = new URL(req.url);

  // When fronted by the link's reverse proxy, the cluster signed the
  // request against the PRE-strip path (e.g. /_sandbox/<handle>/_decopilot_vm/dispatch),
  // not the post-strip path the daemon sees. The proxy forwards the
  // original via X-Forwarded-Path; fall back to url.pathname for direct
  // (non-proxied) callers like loopback tests.
  const signedPath = req.headers.get("x-forwarded-path") ?? url.pathname;
  const verification = verifyRequest({
    secret: deps.bearerSecret,
    method: req.method,
    path: signedPath,
    body,
    headers: Object.fromEntries(req.headers),
    seenNonce: deps.seenNonce,
  });
  if (!verification.valid) {
    return new Response(JSON.stringify({ error: verification.reason }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

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

  let harness: DispatchHarness;
  try {
    harness = deps.lookupHarness(parsed.harnessId, input);
  } catch (err) {
    activeRuns.delete(input.runId);
    return new Response(
      JSON.stringify({
        error: "unknown_harness",
        detail: err instanceof Error ? err.message : String(err),
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: DispatchSSEEvent) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      try {
        for await (const chunk of harness.stream()) {
          if (ctrl.signal.aborted) break;
          write({ type: "ui-message-chunk", chunk });
        }
      } catch (err) {
        write({
          type: "error",
          code: "harness_crashed",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        write({ type: "done" });
        activeRuns.delete(input.runId);
        controller.close();
      }
    },
  });

  return new Response(sseStream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

export async function handleCancelRequest(
  req: Request,
  deps: CancelDeps,
): Promise<Response> {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/runs\/([^/]+)$/);
  if (!match) return new Response(null, { status: 404 });
  const runId = match[1]!;

  const signedPath = req.headers.get("x-forwarded-path") ?? url.pathname;
  const v = verifyRequest({
    secret: deps.bearerSecret,
    method: req.method,
    path: signedPath,
    body: "",
    headers: Object.fromEntries(req.headers),
    seenNonce: deps.seenNonce,
  });
  if (!v.valid) return new Response(null, { status: 401 });

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
