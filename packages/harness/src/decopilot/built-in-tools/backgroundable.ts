import type { Tool } from "ai";

/**
 * Backgroundable tools — opt-in seam for slow tool calls. Some built-ins (e.g.
 * `generate_image`) take tens of seconds; run inline they hold the turn (and
 * the per-thread gate) open. The cluster (DBOS) owns the durable work; this
 * module only defines the `BackgroundDispatcher` seam. Absent on desktop/tests
 * → `makeBackgroundable` returns the inline tool unchanged.
 */

/** Enqueues the real tool work as a durable background job. Cluster-only. */
export interface BackgroundDispatcher {
  start(req: {
    toolName: string;
    input: unknown;
    toolCallId: string;
  }): Promise<{ jobId: string }>;
}

export interface BackgroundStartedOutput {
  background: true;
  status: "started";
  jobId: string;
  note: string;
}

const STARTED_NOTE =
  "Running in the background. The result will appear in the conversation as " +
  "soon as it's ready — keep helping the user in the meantime, and do not " +
  "wait for it or call this tool again for the same request.";

/** Wrap a tool so `execute` enqueues a background job and returns a started
 *  handle. Returns the inner tool unchanged when `dispatcher` is absent. */
export function makeBackgroundable(
  toolName: string,
  innerTool: Tool,
  dispatcher: BackgroundDispatcher | null | undefined,
): Tool {
  if (!dispatcher) return innerTool;
  return {
    ...innerTool,
    execute: async (
      input: unknown,
      options: { toolCallId: string },
    ): Promise<BackgroundStartedOutput> => {
      const { jobId } = await dispatcher.start({
        toolName,
        input,
        toolCallId: options.toolCallId,
      });
      return { background: true, status: "started", jobId, note: STARTED_NOTE };
    },
  } as Tool;
}
