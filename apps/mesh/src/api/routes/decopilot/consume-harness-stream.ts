import { type UIMessage, type UIMessageChunk, createUIMessageStream } from "ai";
import { interceptTitleChunks } from "./title-interceptor";

export interface HarnessStreamPersistence {
  emitStepParts(message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts?: unknown[];
    /** Message metadata (usage, codingAgentSessionId, …). Part of the type
     *  contract so persistence impls (PartEmitter finish anchors) can rely
     *  on it instead of casting. */
    metadata?: unknown;
  }): Promise<void>;
  emitFinal(message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts?: unknown[];
    metadata?: unknown;
  }): Promise<void>;
  emitError(messageId: string, errorText: string): Promise<void>;
}

export type HarnessUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} & Record<string, unknown>;

export interface HarnessStreamConsumerHooks {
  onStep?: (message: UIMessage) => void | Promise<void>;
  /** Fires once on stream completion. `finishReason` is the AI SDK finish
   *  reason derived from the stream's `finish` chunk (undefined when the
   *  stream ended without one, e.g. on a source error). `meta.persistenceOk`
   *  is false when any persistence handoff (emitStepParts/emitFinal) threw —
   *  callers that flip a terminal run status MUST NOT mark the run completed
   *  when it is false (let the durable projector be authoritative). */
  onFinish?: (
    message: UIMessage,
    finishReason?: string,
    meta?: { persistenceOk: boolean },
  ) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onUsage?: (totals: HarnessUsage) => void | Promise<void>;
}

export interface HarnessStreamTitleOptions {
  currentThreadTitle: string | null | undefined;
  threadId: string;
  persistTitle: (threadId: string, title: string) => Promise<void>;
  onTitleUpdated?: (title: string) => void | Promise<void>;
}

export interface ConsumeHarnessStreamOptions {
  chunks: AsyncIterable<UIMessageChunk>;
  originalMessages?: UIMessage[];
  title: HarnessStreamTitleOptions;
  persistence: HarnessStreamPersistence;
  hooks?: HarnessStreamConsumerHooks;
  /**
   * Optional mapper for the USER-VISIBLE error chunk text written to the
   * wire when the chunk source throws. Defaults to the raw `Error.message`.
   * Persistence (`emitError`) always receives the raw text — sanitization
   * for storage is the persistence impl's own concern. Error chunks emitted
   * BY the source pass through verbatim either way; this only shapes the
   * chunk the kernel itself synthesizes from a thrown error.
   */
  sanitizeErrorText?: (error: unknown) => string;
  /**
   * Message id for the error part the kernel synthesizes on a stream error.
   * MUST be deterministic per run (`error-${runId}`) so the SAME error message
   * dedupes across re-projection attempts, DBOS step retries, daemon
   * full-prefix resends, and the live/projector double-write — the
   * deterministic-id idempotency `projectRun` relies on. Defaults to a random
   * UUID only for callers with no run identity (none persist on retry).
   */
  errorMessageId?: string;
}

function asReadableStream<T>(source: AsyncIterable<T>): ReadableStream<T> {
  const iter = source[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { value, done } = await iter.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await iter.return?.(reason);
    },
  });
}

function extractUsage(message: { metadata?: unknown }): HarnessUsage | null {
  const usage = (message.metadata as { usage?: unknown } | undefined)?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    ...u,
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    totalTokens: num(u.totalTokens),
  };
}

export function consumeHarnessStream(options: ConsumeHarnessStreamOptions): {
  uiStream: ReadableStream;
  whenComplete: Promise<void>;
  isStreamFinished: () => boolean;
} {
  const pending: Promise<void>[] = [];
  let streamFinished = false;
  let errored = false;
  // Flipped true when the source AsyncIterable itself throws (as opposed to
  // emitting an in-band {type:"error"} chunk). Used to gate the onFinish hook:
  // an in-band error still allows onFinish to fire (recovery detection); a
  // source throw poisons the run and must suppress it.
  let sourceThrew = false;
  // Flipped false when any persistence handoff throws. Surfaced to the onFinish
  // hook so a live caller does not mark the run completed over a failed write.
  let persistenceOk = true;
  const errorMessageId = options.errorMessageId ?? crypto.randomUUID();
  let resolveComplete!: () => void;
  const whenComplete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });

  const guardedChunks = (async function* () {
    try {
      yield* options.chunks;
    } catch (e) {
      sourceThrew = true;
      throw e;
    }
  })();

  const uiStream = createUIMessageStream({
    originalMessages: options.originalMessages,
    execute: ({ writer }) => {
      const intercepted = interceptTitleChunks(guardedChunks, {
        ctx: null as never,
        isStreamFinished: () => streamFinished,
        currentThreadTitle: options.title.currentThreadTitle,
        threadId: options.title.threadId,
        writer,
        onTitleUpdated: options.title.onTitleUpdated,
        persistTitle: options.title.persistTitle,
      });
      writer.merge(
        asReadableStream(intercepted) as Parameters<typeof writer.merge>[0],
      );
    },
    onStepFinish: ({ responseMessage }) => {
      pending.push(
        options.persistence.emitStepParts(responseMessage).catch((e) => {
          persistenceOk = false;
          console.error("[consume-harness-stream] emitStepParts failed", e);
        }),
      );
      pending.push(
        Promise.resolve(options.hooks?.onStep?.(responseMessage)).catch((e) =>
          console.error("[consume-harness-stream] onStep hook failed", e),
        ),
      );
    },
    onFinish: async ({ responseMessage, finishReason }) => {
      streamFinished = true;
      await Promise.allSettled(pending);
      if (!errored) {
        // Persist the finish reason on the message metadata so a returning
        // user sees the same banner the live stream showed (e.g. the
        // step-limit "tool-calls" "Response incomplete" card) after reload.
        if (finishReason) {
          (responseMessage as { metadata?: Record<string, unknown> }).metadata =
            {
              ...((responseMessage.metadata as Record<string, unknown>) ?? {}),
              finishReason,
            };
        }
        await options.persistence.emitFinal(responseMessage).catch((e) => {
          persistenceOk = false;
          console.error("[consume-harness-stream] emitFinal failed", e);
        });
      }
      // Usage BEFORE the finish hook: finish-hook consumers (dispatch-run's
      // posthog completion event) read the accumulated usage, so it must be
      // delivered first. This mirrors the pre-absorption layering, where the
      // kernel's onUsage always completed before the outer wrapper's
      // onFinish observed the totals.
      const usage = extractUsage(responseMessage);
      if (usage) {
        await Promise.resolve(options.hooks?.onUsage?.(usage)).catch((e) =>
          console.error("[consume-harness-stream] onUsage hook failed", e),
        );
      }
      if (!sourceThrew) {
        await Promise.resolve(
          options.hooks?.onFinish?.(responseMessage, finishReason, {
            persistenceOk,
          }),
        ).catch((e) =>
          console.error("[consume-harness-stream] onFinish hook failed", e),
        );
      }
      resolveComplete();
    },
    onError: (error) => {
      streamFinished = true;
      const text = error instanceof Error ? error.message : String(error);
      if (!errored) {
        errored = true;
        pending.push(
          options.persistence.emitError(errorMessageId, text).catch((e) => {
            persistenceOk = false;
            console.error("[consume-harness-stream] emitError failed", e);
          }),
        );
        pending.push(
          Promise.resolve(options.hooks?.onError?.(error)).catch((e) =>
            console.error("[consume-harness-stream] onError hook failed", e),
          ),
        );
      }
      // The return value becomes the wire error chunk's text when the SDK
      // synthesizes a chunk from a thrown error. (For error chunks the
      // source emitted itself the SDK ignores this return — they pass
      // through verbatim.)
      return options.sanitizeErrorText
        ? options.sanitizeErrorText(error)
        : text;
    },
  });

  return {
    uiStream,
    whenComplete,
    isStreamFinished: () => streamFinished,
  };
}
