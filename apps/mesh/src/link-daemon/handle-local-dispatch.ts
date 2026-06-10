/**
 * handleLocalDispatch — relay a pulled work item to the local sandbox and
 * return completed message parts to the cluster via short JSON append requests.
 *
 * The local sandbox still streams SSE over loopback. The desktop link daemon
 * consumes that stream locally, assembles stable message part rows, and POSTs
 * small idempotent batches to the cluster. This avoids holding a multi-hour
 * streaming upload open through proxies/CDNs.
 *
 * Flow:
 *   1. POST ${sandboxDispatchUrl}/_sandbox/dispatch with a JSON body whose
 *      shape mirrors what `remote-dispatch.ts` sends:
 *        { harnessId: <id>, input: <HarnessStreamInputWire> }
 *      The local sandbox daemon authenticates the request via Bearer
 *      `sandboxDaemonToken` and returns a `text/event-stream` SSE body of
 *      `ui-message-chunk` / `error` / `done` events.
 *
 *   2. Convert the SSE response body to durable part batches and POST each
 *      batch to the cluster ingest endpoint:
 *        POST ${clusterBaseUrl}/api/${orgSlug}/links/runs/${runId}/parts
 *      with `x-fence-token: ${runFenceToken}` and `Authorization: Bearer
 *      <cluster token>`.
 *
 * ⚠️ ORG SLUG vs ID NOTE:
 *   WorkItem carries `orgId` (the DB UUID) and `orgSlug` (the URL-safe slug).
 *   The ingest route uses `resolveOrgFromPath` which looks up the org by slug
 *   (the `:org` path segment in `/api/:org/links/runs/...`). The work item's
 *   `orgSlug` is authoritative for the ingest URL.
 *
 * ⚠️ HARNESS ID NOTE:
 *   `WorkItem.harnessInput` is a `HarnessStreamInputWire`. As of link
 *   protocol v2 the cluster includes a first-class top-level `harnessId`
 *   field on the wire input, so reading
 *   `(work.harnessInput as Record<string,unknown>).harnessId` is the primary
 *   path. The legacy fallback chain stays for now: if absent, we fall back
 *   to `work.harnessInput.agent?.id` (which older dispatchers set to the
 *   harness type string, e.g. "claude-code"), then default to "claude-code"
 *   (the canonical desktop harness). Callers can override via
 *   `deps.harnessId` if the caller knows the correct value.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
import { retry, RetryError } from "@decocms/std";
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";
import { relayDispatchSSEAsPartBatches } from "./link-part-batcher";

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
   * Cluster origin, e.g. "https://studio.deco.cx". The ingest POSTs are sent
   * to `${clusterBaseUrl}/api/${orgSlug}/links/runs/${runId}/parts`.
   */
  clusterBaseUrl: string;
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
 * Run a pulled work item against the local sandbox and append completed part
 * batches to the cluster ingest. Resolves when all batch POSTs complete.
 * Throws on:
 *   - A non-2xx response from the sandbox dispatch (JSON error is extracted
 *     and included in the thrown Error, mirroring remote-dispatch.ts).
 *   - A non-2xx response from any cluster append.
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

  // ── Step 2: append parsed part batches to the cluster ingest ───────────
  const clusterToken = await deps.getClusterToken();
  const ingestUrl = `${deps.clusterBaseUrl}/api/${work.orgSlug}/links/runs/${work.runId}/parts`;

  await relayDispatchSSEAsPartBatches({
    dispatchBody: dispatchRes.body,
    runId: work.runId,
    orgId: work.orgId,
    postBatch: async (batch) => {
      try {
        await retry(
          async () => {
            const ingestRes = await fetcher(ingestUrl, {
              method: "POST",
              headers: {
                authorization: `Bearer ${clusterToken}`,
                "x-fence-token": work.runFenceToken,
                "content-type": "application/json",
              },
              body: JSON.stringify(batch),
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
              const err = new Error(`[handleLocalDispatch] ${detail}`);
              (err as { status?: number }).status = ingestRes.status;
              throw err;
            }
          },
          {
            maxAttempts: 5,
            minTimeout: 250,
            maxTimeout: 5_000,
            signal: deps.signal,
            isRetriable: (err) => {
              const status = (err as { status?: number }).status;
              return status === undefined || status >= 500;
            },
          },
        );
      } catch (error) {
        if (error instanceof RetryError) throw error.cause;
        throw error;
      }
    },
  });
}
