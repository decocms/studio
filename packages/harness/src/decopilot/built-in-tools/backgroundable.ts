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

/** Subscribes a running foreground call so it can be flipped to the background
 *  mid-flight. `flipped` resolves when the user requests the flip for this
 *  toolCallId; `dispose` cleans up the subscription when the call ends. Wired by
 *  the app to its flip-registry (cluster main turn); absent → no flip support,
 *  a foreground call just runs inline. Only the generator branch honors it. */
export interface FlipSubscription {
  flipped: Promise<void>;
  dispose(): void;
}
export type FlipSubscribe = (toolCallId: string) => FlipSubscription;

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

function isBackgroundStarted(
  output: unknown,
): output is BackgroundStartedOutput {
  return (
    !!output &&
    typeof output === "object" &&
    (output as BackgroundStartedOutput).status === "started" &&
    (output as BackgroundStartedOutput).background === true
  );
}

/**
 * Wrap a tool so the model can opt a call into the background via `background:
 * true`. The schema is extended with that prop; at call time a true value
 * enqueues a durable job (returning a started handle), anything else runs the
 * inner tool inline. The inner tool's execute SHAPE is preserved — a generator
 * (e.g. subtask, which streams progress) stays a generator; a plain async tool
 * (e.g. generate_image) stays async — so neither's streaming/rendering changes.
 * Returns the inner tool unchanged when `dispatcher` is absent.
 *
 * With a `flip` subscriber, a FOREGROUND generator call can also be moved to the
 * background mid-flight (the user clicking "run in background"): the inline run
 * is aborted and the call takes its background branch, so the turn completes
 * normally — with the started marker as the tool output — and the per-thread
 * gate frees up. The lost in-flight work re-runs as the durable job.
 */
export function makeBackgroundable<S extends z.ZodObject<z.ZodRawShape>>(
  toolName: string,
  baseSchema: S,
  innerTool: Tool,
  dispatcher: BackgroundDispatcher | null | undefined,
  flip?: FlipSubscribe,
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
        const startBackground = async function* () {
          const { jobId } = await dispatcher.start({
            toolName,
            input: rest,
            toolCallId: options.toolCallId,
          });
          yield startedHandle(jobId);
        };
        if (background) {
          yield* startBackground();
          return;
        }
        const flipSub = flip?.(options.toolCallId);
        if (!flipSub) {
          yield* innerExecute(rest, options) as AsyncIterable<unknown>;
          return;
        }
        // The inner run gets a CHILD abort signal so a flip stops only this
        // subagent, not the whole parent turn (aborting the turn would cancel
        // the very job we're about to start). The parent's own abort still
        // forwards down — a real cancel aborts the inner and propagates.
        const childAbort = new AbortController();
        const onParentAbort = () => childAbort.abort();
        options.abortSignal?.addEventListener("abort", onParentAbort, {
          once: true,
        });
        const iter = (
          innerExecute(rest, {
            ...options,
            abortSignal: childAbort.signal,
          }) as AsyncIterable<unknown>
        )[Symbol.asyncIterator]();
        try {
          let pending = iter.next();
          // `tagged` is the raced view of `pending`; keep the handle so the flip
          // branch can swallow its eventual rejection (the inner throws on abort)
          // instead of leaking an unhandled rejection once we stop awaiting it.
          let tagged = pending.then((r) => ({ kind: "next" as const, r }));
          while (true) {
            const ev = await Promise.race([
              tagged,
              flipSub.flipped.then(() => ({ kind: "flip" as const })),
            ]);
            if (ev.kind === "flip") {
              // Stop the inline run and tear it down in the background — its
              // `finally` releases the concurrency slot + closes the MCP client.
              // We do NOT await teardown: a hung provider await must not stall
              // the flip. Then take the background branch.
              // ponytail: in the rare photo-finish where the run just completed,
              // this re-runs it in the background (a few seconds wasted) rather
              // than returning the just-ready result — never wrong, and cheaper
              // than the drain-and-inspect that risks hanging on that await.
              childAbort.abort();
              tagged.catch(() => {}); // abandoned branch may reject on abort
              void (async () => {
                try {
                  await pending;
                } catch {
                  /* aborted */
                }
                try {
                  await iter.return?.(undefined);
                } catch {
                  /* ignore */
                }
              })();
              yield* startBackground();
              return;
            }
            if (ev.r.done) return;
            yield ev.r.value;
            pending = iter.next();
            tagged = pending.then((r) => ({ kind: "next" as const, r }));
          }
        } finally {
          options.abortSignal?.removeEventListener("abort", onParentAbort);
          flipSub.dispose();
        }
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

  // The started/background handle isn't a real inner-tool output — the inner
  // toModelOutput (built for the inner tool's own result shape) doesn't
  // recognize it and falls through to a generic "no output" text, hiding the
  // note that tells the model the result arrives later. Intercept it here so
  // every backgroundable tool (explicit `background: true` AND a flip) tells
  // the model it's running in the background instead of looking finished.
  const toModelOutput: Tool["toModelOutput"] = (args: {
    toolCallId: string;
    input: unknown;
    output: unknown;
  }) => {
    if (isBackgroundStarted(args.output)) {
      return { type: "text" as const, value: args.output.note };
    }
    if (innerTool.toModelOutput) return innerTool.toModelOutput(args as never);
    return { type: "text" as const, value: JSON.stringify(args.output) };
  };

  return { ...innerTool, inputSchema, execute, toModelOutput } as Tool;
}
