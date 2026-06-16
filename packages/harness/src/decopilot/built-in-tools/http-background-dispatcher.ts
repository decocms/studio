import type { BackgroundDispatcher } from "./backgroundable";

/**
 * Desktop-daemon `BackgroundDispatcher`: enqueues the slow tool's work back on
 * the CLUSTER instead of running it locally. The daemon has no DBOS and is
 * ephemeral; the cluster owns durability, the org credentials, and the thread
 * DB. So `start()` POSTs to the cluster's fence-authed enqueue route, which
 * runs the existing `backgroundToolWorkflow` (generate → append → react). The
 * daemon's tool returns the started handle immediately and its turn ends.
 *
 * Auth reuses the same bearer the daemon already presents for object storage /
 * MCP (the run's 1h temp key), plus the run fence token (single-writer guard).
 */
export interface HttpBackgroundDispatcherOptions {
  /** Cluster enqueue endpoint, e.g. `${base}/threads/${threadId}/background-tool`. */
  url: string;
  /** Authenticated headers (Authorization bearer + x-org-id) from the run. */
  headers: Record<string, string>;
  /** Run fence token — must match the cluster's active run fence. */
  fenceToken: string;
  /** Thread/model snapshot the cluster needs to rebuild the reaction turn. */
  snapshot: {
    agentId: string;
    temperature: number;
    toolApprovalLevel: string;
    branch: string | null;
  };
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export function createHttpBackgroundDispatcher(
  options: HttpBackgroundDispatcherOptions,
): BackgroundDispatcher {
  const fetchFn = options.fetch ?? fetch;
  return {
    start: async ({ toolName, input, toolCallId }) => {
      const res = await fetchFn(options.url, {
        method: "POST",
        headers: {
          ...options.headers,
          "content-type": "application/json",
          "x-fence-token": options.fenceToken,
        },
        body: JSON.stringify({
          toolName,
          input,
          toolCallId,
          ...options.snapshot,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `background-tool enqueue failed (${res.status}): ${detail}`,
        );
      }
      const body = (await res.json()) as { jobId?: string };
      if (!body.jobId) {
        throw new Error("background-tool enqueue returned no jobId");
      }
      return { jobId: body.jobId };
    },
  };
}
