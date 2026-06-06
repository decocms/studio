/**
 * handleLocalDispatch — relay a pulled work item to the local sandbox and
 * stream the SSE result back to the cluster ingest (Phase D, Task 7).
 *
 * Flow:
 *   1. POST ${sandboxDispatchUrl}/_sandbox/dispatch with a JSON body whose
 *      shape mirrors what `remote-dispatch.ts` sends:
 *        { harnessId: <id>, input: <HarnessStreamInputWire> }
 *      The local sandbox daemon authenticates the request via Bearer
 *      `sandboxDaemonToken` and returns a `text/event-stream` SSE body of
 *      `ui-message-chunk` / `error` / `done` events.
 *
 *   2. Relay the SSE response body — WITHOUT buffering — as a chunked
 *      POST to the cluster ingest endpoint:
 *        POST ${clusterBaseUrl}/api/${orgSlug}/links/runs/${runId}/stream
 *      with `x-fence-token: ${runFenceToken}` and `Authorization: Bearer
 *      <cluster token>`. This is the Phase-A ingest endpoint
 *      (link-ingest-routes.ts) which commits parts to durable storage.
 *
 * ⚠️ ORG SLUG vs ID NOTE:
 *   WorkItem carries `orgId` (the DB UUID), but the ingest route uses
 *   `resolveOrgFromPath` which looks up the org by its URL-safe SLUG (the
 *   `:org` path segment in `/api/:org/links/runs/...`). The caller (Task 8
 *   / index.ts pull-loop-entry) MUST supply `orgSlug` in LocalDispatchDeps
 *   — it is NOT derivable from orgId here without a DB lookup. The
 *   `runWorkPollLoop` already receives `orgSlug`; the onWork handler should
 *   thread it through to `handleLocalDispatch`.
 *
 * ⚠️ HARNESS ID NOTE:
 *   `WorkItem.harnessInput` is a `HarnessStreamInputWire` — a plain JSON
 *   record without a top-level `harnessId` field (the `harnessId` is passed
 *   *beside* the input in the dispatch POST body, as in remote-dispatch.ts).
 *   We read `(work.harnessInput as Record<string,unknown>).harnessId` first
 *   (a future schema version or the cluster may include it); if absent, we
 *   fall back to `work.harnessInput.agent?.id` (which the cluster sets to
 *   the harness type string, e.g. "claude-code"). If that is also absent, we
 *   default to "claude-code" (the canonical desktop harness).  Callers can
 *   override via `deps.harnessId` if the caller knows the correct value.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";

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
   * Cluster origin, e.g. "https://studio.deco.cx". The ingest POST is sent
   * to `${clusterBaseUrl}/api/${orgSlug}/links/runs/${runId}/stream`.
   */
  clusterBaseUrl: string;
  /**
   * Org SLUG for the ingest URL path segment. MUST be the slug, not the
   * UUID orgId — resolveOrgFromPath looks up by slug. The caller (Task 8 /
   * pull-loop-entry) sources this from the same `orgSlug` it passes to
   * `runWorkPollLoop`.
   */
  orgSlug: string;
  /**
   * Returns the bearer token for the cluster ingest endpoint. Called once
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
   * Abort signal propagated to both the sandbox dispatch fetch and the
   * cluster ingest fetch.
   */
  signal?: AbortSignal;
}

/**
 * Derive the harness id from the work item. Priority:
 *   1. `deps.harnessId` if the caller supplied one.
 *   2. `work.harnessInput.harnessId` — a future schema may include it.
 *   3. `work.harnessInput.agent.id` — the cluster sets this to the harness
 *      type string (e.g. "claude-code", "codex").
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
 * Run a pulled work item against the local sandbox and stream the SSE result
 * to the cluster ingest. Resolves when the ingest POST completes (i.e. the
 * full SSE body has been relayed). Throws on:
 *   - A non-2xx response from the sandbox dispatch (JSON error is extracted
 *     and included in the thrown Error, mirroring remote-dispatch.ts).
 *   - A non-2xx response from the cluster ingest.
 *   - Any network error from either fetch.
 */
export async function handleLocalDispatch(
  work: WorkItem,
  deps: LocalDispatchDeps,
): Promise<void> {
  const fetcher = deps.fetchImpl ?? fetch;
  const harnessId = deriveHarnessId(work, deps.harnessId);

  // ── Step 1: POST to the local sandbox daemon's /_sandbox/dispatch ──────
  // Body shape mirrors remote-dispatch.ts: { harnessId, input } or, when the
  // cluster offloaded messages, { harnessId, input, messagesRef }.
  // `work.harnessInput` IS the HarnessStreamInputWire (messages:[] when
  // offloaded). The sandbox daemon validates input against
  // harnessStreamInputSchema and re-inflates messages from messagesRef when
  // present — identical to the WS path (remote-dispatch.ts sends the same
  // envelope shape to the same /_sandbox/dispatch endpoint).
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

  // Mirror remote-dispatch.ts non-2xx handling: read the JSON error body and
  // throw BEFORE any SSE parsing so a failed run never looks successful.
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

  // ── Step 2: relay the SSE body to the cluster ingest (no buffering) ────
  // The SSE stream is piped directly as the ingest POST body using the
  // Fetch streaming upload API (`body: ReadableStream, duplex: "half"`).
  // This avoids buffering the entire run output in memory.
  const clusterToken = await deps.getClusterToken();
  const ingestUrl = `${deps.clusterBaseUrl}/api/${deps.orgSlug}/links/runs/${work.runId}/stream`;

  const ingestRes = await fetcher(ingestUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${clusterToken}`,
      "x-fence-token": work.runFenceToken,
      "content-type": "text/event-stream",
    },
    body: dispatchRes.body,
    // @ts-expect-error — `duplex: "half"` is required by the Fetch spec for
    // streaming request bodies. Not yet in all TypeScript DOM typings but
    // supported by Node/Bun/undici. See:
    // https://fetch.spec.whatwg.org/#dom-requestinit-duplex
    duplex: "half",
    signal: deps.signal,
  });

  if (!ingestRes.ok) {
    let detail = `ingest failed (${ingestRes.status})`;
    try {
      const j = (await ingestRes.json()) as Record<string, unknown>;
      if (j && typeof j.error === "string" && j.error) {
        detail = j.error;
      }
    } catch {
      // JSON parse failed — keep the status-code detail.
    }
    throw new Error(`[handleLocalDispatch] ${detail}`);
  }
}
