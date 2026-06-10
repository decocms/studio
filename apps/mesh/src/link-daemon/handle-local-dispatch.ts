/**
 * handleLocalDispatch — relay a pulled work item to the local sandbox and
 * stream its raw chunk output back to the cluster.
 *
 * The local sandbox streams SSE over loopback. The desktop link daemon
 * forwards every `DispatchSSEEvent` verbatim to the cluster as seq-numbered
 * NDJSON relay lines (see `chunk-relay.ts`), so the cluster-side harness
 * kernel is the single consumer of harness output — titles, usage, and
 * session metadata survive because the daemon no longer folds chunks into
 * part rows. The relay buffers all unacked lines and, when the streaming
 * upload drops, reconnects and resends the whole prefix from seq 1 (the
 * cluster dedupes by seq), so multi-hour runs survive transient drops.
 *
 * Flow:
 *   1. POST ${sandboxDispatchUrl}/_sandbox/dispatch with a JSON body of shape:
 *        { harnessId: <id>, input: <HarnessStreamInputWire> }
 *      The local sandbox daemon authenticates the request via Bearer
 *      `sandboxDaemonToken` and returns a `text/event-stream` SSE body of
 *      `ui-message-chunk` / `error` / `done` events.
 *
 *   2. Relay the SSE body as an NDJSON stream of `RelayLine`s:
 *        POST ${clusterBaseUrl}/api/${orgSlug}/links/runs/${runId}/chunks
 *      with `x-fence-token: ${runFenceToken}`, `x-relay-from: <fromSeq>`
 *      (resend start, always 1), `content-type: application/x-ndjson`, and
 *      `Authorization: Bearer <cluster token>`, as a `duplex:"half"`
 *      streaming upload. The cluster replies `{ ok, lastSeq }` once the body
 *      ends.
 *
 * ⚠️ ORG SLUG vs ID NOTE:
 *   WorkItem carries `orgId` (the DB UUID) and `orgSlug` (the URL-safe slug).
 *   The chunks route uses `resolveOrgFromPath` which looks up the org by slug
 *   (the `:org` path segment in `/api/:org/links/runs/...`). The work item's
 *   `orgSlug` is authoritative for the relay URL.
 *
 * ⚠️ HARNESS ID NOTE:
 *   `WorkItem.harnessInput` is a `HarnessStreamInputWire`. As of link
 *   protocol v2 the cluster sets the first-class top-level `harnessId`
 *   field on every dispatch — that is the primary path (see
 *   `deriveHarnessId`). The fallback chain (agent.id → "claude-code") is
 *   defense-in-depth only and can die with the next protocol bump. Callers
 *   can override via `deps.harnessId` if they know the correct value.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";
import {
  type RelayPostResult,
  relayDispatchSSEAsChunkStream,
} from "./chunk-relay";

/**
 * Relay a synthesized terminal failure for a work item that cannot run
 * (expired credentials, etc.) over the normal /chunks channel, so the
 * cluster kernel persists the failure and the gate unblocks.
 *
 * Posts exactly two NDJSON relay lines:
 *   seq 1 — error event with `code` + `message`
 *   seq 2 — done event
 *
 * Security note: `code` and `message` are informational strings — they must
 * never contain the fence token, API keys, or any other secret from the work
 * item. This function deliberately does NOT log any secret fields.
 */
export async function relayWorkItemFailure(
  work: WorkItem,
  deps: Pick<
    LocalDispatchDeps,
    "clusterBaseUrl" | "getClusterToken" | "fetchImpl" | "signal"
  >,
  code: string,
  message: string,
): Promise<void> {
  const fetcher = deps.fetchImpl ?? fetch;
  const clusterToken = await deps.getClusterToken();
  const body =
    JSON.stringify({ seq: 1, event: { type: "error", code, message } }) +
    "\n" +
    JSON.stringify({ seq: 2, event: { type: "done" } }) +
    "\n";
  const res = await fetcher(
    `${deps.clusterBaseUrl}/api/${work.orgSlug}/links/runs/${work.runId}/chunks`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${clusterToken}`,
        "x-fence-token": work.runFenceToken,
        "content-type": "application/x-ndjson",
        "x-relay-from": "1",
      },
      body,
      signal: deps.signal,
    },
  );
  if (!res.ok) {
    throw new Error(
      `[relayWorkItemFailure] cluster rejected failure relay (${res.status})`,
    );
  }
}

export interface LocalDispatchDeps {
  /**
   * Base URL of the local sandbox daemon (loopback), e.g.
   * "http://127.0.0.1:9123". Ensured by the caller before invoking
   * handleLocalDispatch.
   */
  sandboxDispatchUrl: string;
  /**
   * Bearer token for the local `/_sandbox/dispatch` endpoint. Generated at
   * sandbox spawn time (see DesktopSandboxProvider.daemonToken).
   */
  sandboxDaemonToken: string;
  /**
   * Cluster origin, e.g. "https://studio.deco.cx". The relay upload is sent
   * to `${clusterBaseUrl}/api/${orgSlug}/links/runs/${runId}/chunks`.
   */
  clusterBaseUrl: string;
  /**
   * Returns the bearer token for the cluster chunks endpoint. Called once
   * per dispatch so that a refreshed token is used (mirrors work-poller's
   * per-poll `getAccessToken` pattern).
   */
  getClusterToken: () => Promise<string> | string;
  /**
   * Optional override for the harness id sent in the dispatch POST body.
   * When omitted, derived from `work.harnessInput` (see module note).
   */
  harnessId?: string;
  /**
   * Injected fetch implementation. Defaults to global `fetch`.
   * Tests inject a stub here to avoid real HTTP.
   */
  fetchImpl?: typeof fetch;
  /**
   * Abort signal propagated to the sandbox dispatch fetch, the chunk relay,
   * and every cluster relay fetch.
   */
  signal?: AbortSignal;
}

/**
 * Derive the harness id from the work item.
 *
 * Primary path: `work.harnessInput.harnessId` — first-class on the wire as
 * of link protocol v2 and always set by v2 dispatch. The rest of the chain
 * is defense-in-depth only and can die with the next protocol bump:
 *   1. `deps.harnessId` — explicit caller override.
 *   2. `work.harnessInput.harnessId` — the v2 wire field (primary).
 *   3. `work.harnessInput.agent.id` — older dispatchers set this to the
 *      harness type string (e.g. "claude-code", "codex").
 *   4. "claude-code" — the canonical desktop harness fallback.
 */
function deriveHarnessId(work: WorkItem, depsHarnessId?: string): string {
  if (depsHarnessId) return depsHarnessId;
  const input = work.harnessInput as Record<string, unknown>;
  if (typeof input.harnessId === "string" && input.harnessId.length > 0) {
    return input.harnessId;
  }
  const agent = input.agent as Record<string, unknown> | undefined;
  if (typeof agent?.id === "string" && agent.id.length > 0) {
    return agent.id;
  }
  return "claude-code";
}

/**
 * Run a pulled work item against the local sandbox and relay its raw SSE
 * events to the cluster chunks endpoint as seq-numbered NDJSON. Resolves when
 * a relay upload completes successfully after the terminal `done` line.
 * Throws on:
 *   - A non-2xx response from the sandbox dispatch (JSON error is extracted
 *     and included in the thrown Error).
 *   - A permanent relay failure (non-retriable 4xx, or 5 failed attempts).
 *   - Relay buffer overflow (RELAY_BUFFER_MAX_BYTES) or abort.
 */
export async function handleLocalDispatch(
  work: WorkItem,
  deps: LocalDispatchDeps,
): Promise<void> {
  const fetcher = deps.fetchImpl ?? fetch;
  const harnessId = deriveHarnessId(work, deps.harnessId);

  // ── Step 1: POST to the local sandbox daemon's /_sandbox/dispatch ──────
  // Body shape: { harnessId, input } or, when the cluster offloaded messages,
  // { harnessId, input, messagesRef }. `work.harnessInput` IS the
  // HarnessStreamInputWire (messages:[] when offloaded). The sandbox daemon
  // validates input against harnessStreamInputSchema and re-inflates messages
  // from messagesRef when present.
  const dispatchBody = work.messagesRef
    ? JSON.stringify({
        harnessId,
        input: work.harnessInput,
        messagesRef: work.messagesRef,
      })
    : JSON.stringify({
        harnessId,
        input: work.harnessInput,
      });

  const dispatchRes = await fetcher(
    `${deps.sandboxDispatchUrl}/_sandbox/dispatch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.sandboxDaemonToken}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: dispatchBody,
      signal: deps.signal,
    },
  );

  // Non-2xx handling: read the JSON error body and throw BEFORE any SSE
  // parsing so a failed run never looks successful (an error Response carries
  // no `data:` lines, so feeding it to the parser would yield a silent-empty
  // stream).
  if (!dispatchRes.ok) {
    let detail = `dispatch failed (${dispatchRes.status})`;
    try {
      const j = (await dispatchRes.json()) as Record<string, unknown>;
      if (j && typeof j.error === "string" && j.error) {
        detail = j.error;
      }
    } catch {
      // JSON parse failed — keep the status-code detail.
    }
    throw new Error(`[handleLocalDispatch] ${detail}`);
  }

  if (!dispatchRes.body) {
    throw new Error("[handleLocalDispatch] dispatch response body is null");
  }

  // ── Step 2: relay raw chunk lines to the cluster /chunks endpoint ──────
  // Retry/backoff and full-prefix resend live inside the chunk relay; this
  // post impl performs exactly one streaming upload attempt.
  const clusterToken = await deps.getClusterToken();
  const chunksUrl = `${deps.clusterBaseUrl}/api/${work.orgSlug}/links/runs/${work.runId}/chunks`;

  await relayDispatchSSEAsChunkStream({
    dispatchBody: dispatchRes.body,
    runId: work.runId,
    signal: deps.signal,
    post: async (body, fromSeq) => {
      const res = await fetcher(chunksUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${clusterToken}`,
          "x-fence-token": work.runFenceToken,
          "content-type": "application/x-ndjson",
          "x-relay-from": String(fromSeq),
        },
        body,
        // @ts-expect-error — `duplex: "half"` is required by the Fetch spec
        // for streaming request bodies; supported by Node/Bun/undici but not
        // yet in TS DOM typings (same pattern as proxy-poller.ts). Verified
        // on Bun 1.3.14: the upload is delivered incrementally.
        duplex: "half",
        signal: deps.signal,
      });
      if (!res.ok) {
        const err = new Error(
          `[handleLocalDispatch] relay failed (${res.status})`,
        );
        (err as { status?: number }).status = res.status;
        throw err;
      }
      return (await res.json()) as RelayPostResult;
    },
  });
}
