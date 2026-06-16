import type { Tool } from "ai";

/**
 * Backgroundable tools — opt-in mechanism for slow tool calls.
 *
 * Some built-in tools (e.g. `generate_image`) can take tens of seconds. Run
 * inline, they hold the agent-loop step open, which keeps the turn — and the
 * per-thread gate — busy, so the user can't send another message until the
 * tool finishes. A backgroundable tool instead hands the work to a durable
 * background job and returns IMMEDIATELY with a handle. The model finishes its
 * turn, the thread frees up, and the job delivers its result into the thread
 * later (see the cluster's background-tool workflow).
 *
 * The heavy work + durability live in the cluster (DBOS). This module only
 * defines the seam: a `BackgroundDispatcher` the wrapper calls. When no
 * dispatcher is injected (desktop, tests), `makeBackgroundable` returns the
 * inline tool unchanged — backgrounding is a cluster capability, not a
 * behavior change everywhere.
 */

/**
 * Enqueues the real tool work as a durable background job and returns a handle
 * the model can mention. Implemented by the cluster; absent on desktop/tests.
 */
export interface BackgroundDispatcher {
  start(req: {
    /** Backgroundable tool name, used to route to the right heavy fn. */
    toolName: string;
    /** The model-supplied tool input, forwarded to the background job. */
    input: unknown;
    /** The originating tool call id (for correlation / telemetry). */
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

/**
 * Wrap a tool so its `execute` enqueues a background job and returns a started
 * handle instead of blocking the turn. Returns the inner tool unchanged when
 * `dispatcher` is null/undefined, so callers can wrap unconditionally.
 */
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
    // The wrapper's execute returns a different shape than the inline tool; the
    // AI SDK only needs a callable here, so widen back to the inner tool type.
  } as Tool;
}
