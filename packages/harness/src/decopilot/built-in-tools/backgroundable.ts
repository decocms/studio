import { zodSchema, type Tool, type ToolCallOptions } from "ai";
import { z } from "zod";

/**
 * Backgroundable tools — the ONE generic seam for slow tool calls. Some built-ins
 * (generate_image, subtask) take tens of seconds; run inline they hold the turn
 * (and the per-thread gate) open. `makeBackgroundable` wraps any such tool: it
 * injects a `background` boolean into the input schema and, when the model sets
 * it, enqueues a durable job and returns immediately; otherwise the tool runs
 * inline unchanged. The cluster (DBOS) owns the durable work; this module only
 * defines the seam + the `BackgroundDispatcher`. Absent dispatcher
 * (desktop without link material, tests) → the tool is returned untouched and
 * `background` isn't even advertised.
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

/** The opt-in prop injected into every backgroundable tool's input schema. */
const BACKGROUND_PROP = {
  background: z
    .boolean()
    .optional()
    .describe(
      "Run this in the BACKGROUND and return immediately instead of blocking " +
        "this turn. Set true for long, fire-and-forget work whose result you do " +
        "NOT need in this same reply — it's delivered to the conversation when " +
        "it finishes and you'll be nudged to use it then. Leave false/omit when " +
        "you need the result now to act on it this turn.",
    ),
};

function startedHandle(jobId: string): BackgroundStartedOutput {
  return { background: true, status: "started", jobId, note: STARTED_NOTE };
}

/**
 * Wrap a tool so the model can opt a call into the background via `background:
 * true`. The schema is extended with that prop; at call time a true value
 * enqueues a durable job (returning a started handle), anything else runs the
 * inner tool inline. The inner tool's execute SHAPE is preserved — a generator
 * (e.g. subtask, which streams progress) stays a generator; a plain async tool
 * (e.g. generate_image) stays async — so neither's streaming/rendering changes.
 * Returns the inner tool unchanged when `dispatcher` is absent.
 */
export function makeBackgroundable<S extends z.ZodObject<z.ZodRawShape>>(
  toolName: string,
  baseSchema: S,
  innerTool: Tool,
  dispatcher: BackgroundDispatcher | null | undefined,
): Tool {
  if (!dispatcher) return innerTool;

  const innerExecute = innerTool.execute as (
    input: unknown,
    options: ToolCallOptions,
  ) => unknown;
  const inputSchema = zodSchema(baseSchema.extend(BACKGROUND_PROP));
  const isGenerator =
    (innerExecute as { constructor: { name: string } }).constructor.name ===
    "AsyncGeneratorFunction";

  const execute = isGenerator
    ? async function* (
        input: Record<string, unknown>,
        options: ToolCallOptions,
      ) {
        const { background, ...rest } = input;
        if (background) {
          const { jobId } = await dispatcher.start({
            toolName,
            input: rest,
            toolCallId: options.toolCallId,
          });
          yield startedHandle(jobId);
          return;
        }
        yield* innerExecute(rest, options) as AsyncIterable<unknown>;
      }
    : async (input: Record<string, unknown>, options: ToolCallOptions) => {
        const { background, ...rest } = input;
        if (background) {
          const { jobId } = await dispatcher.start({
            toolName,
            input: rest,
            toolCallId: options.toolCallId,
          });
          return startedHandle(jobId);
        }
        return innerExecute(rest, options);
      };

  return { ...innerTool, inputSchema, execute } as Tool;
}
