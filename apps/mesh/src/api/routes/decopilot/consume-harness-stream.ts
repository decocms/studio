import { type UIMessage, type UIMessageChunk, createUIMessageStream } from "ai";
import {
  interceptTitleChunks,
  interceptTitleChunkStream,
} from "./title-interceptor";

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
  chunks?: AsyncIterable<UIMessageChunk>;
  chunkStream?: ReadableStream<UIMessageChunk>;
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
   * MUST be deterministic per turn (`error-${runId}:${fenceToken}`, see
   * message-ids.ts) so the SAME error message dedupes across re-projection
   * attempts, DBOS step retries, daemon full-prefix resends, and the
   * live/projector double-write — the deterministic-id idempotency the
   * projector relies on — while DISTINCT turns of the same thread never
   * collide. Defaults to a random UUID only for callers with no run identity
   * (none persist on retry).
   */
  errorMessageId?: string;
  /**
   * Optional override id scheme for the reassembled message(s). Only the
   * `background-tool-workflow` caller passes this — it imposes its own
   * `${jobId}:msg:${n}` ids. The decopilot projection paths DO NOT pass it: they
   * keep the harness `start.messageId` verbatim (every harness stamps one via the
   * shared generateMessageId; createUIMessageStream preserves it), and the
   * continuation merge is derived from `originalMessages` instead (the first
   * folded message adopts a trailing assistant message's id). See the
   * id-resolution block below and message-id-unification-design.md.
   */
  generateMessageId?: () => string;
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

function guardReadableStream<T>(
  source: ReadableStream<T>,
  onError: () => void,
): ReadableStream<T> {
  const reader = source.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        onError();
        release();
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      release();
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

  if (!options.chunks && !options.chunkStream) {
    throw new Error("consumeHarnessStream requires chunks or chunkStream");
  }

  const guardedChunks = options.chunks
    ? (async function* () {
        try {
          yield* options.chunks!;
        } catch (e) {
          sourceThrew = true;
          throw e;
        }
      })()
    : null;
  const guardedChunkStream = options.chunkStream
    ? guardReadableStream(options.chunkStream, () => {
        sourceThrew = true;
      })
    : null;

  // The message id authority is the harness's `start.messageId`. Every harness
  // stamps a stable `msg_…` id into each message's `start` chunk (shared
  // generateMessageId), and createUIMessageStream preserves it through the fold,
  // so the reassembled message.id IS that harness id — stable across every
  // re-fold because it lives in the replayed chunk log (`${runId}:${messageId}:
  // ${seq}` row ids then dedupe on ON CONFLICT). We keep it verbatim, with two
  // exceptions:
  //
  //   - `generateMessageId` set: a caller (background-tool-workflow) imposes its
  //     OWN id scheme; remap each SDK message id through it in fold order, memoized
  //     so repeated onStepFinish passes for the same message stay stable.
  //   - CONTINUATION merge (decopilot approval / tool-output rounds): when no
  //     generateMessageId is passed and `originalMessages` ends with an assistant
  //     message (the re-POSTed proposal), the FIRST folded message adopts that
  //     trailing id so the continuation merges onto the proposal row instead of
  //     creating a second one. Subsequent messages keep their own harness ids.
  //
  //     This is idempotent across re-folds ONLY because a decopilot turn is a
  //     SINGLE UI message (one `toUIMessageStream` => one message): the trailing
  //     originalMessage stays the proposal and the first chunk-log id stays the
  //     same, so the first->proposal remap is stable on every re-fold. If a
  //     continuation ever emits MULTIPLE messages, a re-fold would see
  //     `originalMessages` ending in the LAST persisted message (not the
  //     proposal) and adopt the wrong id — guard that (match the proposal id
  //     explicitly) before multi-message continuations become reachable.
  const trailingOriginal = options.originalMessages?.at(-1);
  const continuationMessageId =
    !options.generateMessageId && trailingOriginal?.role === "assistant"
      ? trailingOriginal.id
      : undefined;
  const messageIdRemap = new Map<string, string>();
  let firstSdkId: string | null = null;
  const resolveMessageId = (sdkId: string): string => {
    if (options.generateMessageId) {
      let id = messageIdRemap.get(sdkId);
      if (id === undefined) {
        id = options.generateMessageId();
        messageIdRemap.set(sdkId, id);
      }
      return id;
    }
    if (firstSdkId === null) firstSdkId = sdkId;
    return continuationMessageId && sdkId === firstSdkId
      ? continuationMessageId
      : sdkId;
  };
  const withStableId = <M extends { id: string }>(message: M): M => ({
    ...message,
    id: resolveMessageId(message.id),
  });

  const uiStream = createUIMessageStream({
    originalMessages: options.originalMessages,
    execute: ({ writer }) => {
      const titleDeps = {
        ctx: null as never,
        isStreamFinished: () => streamFinished,
        currentThreadTitle: options.title.currentThreadTitle,
        threadId: options.title.threadId,
        writer,
        onTitleUpdated: options.title.onTitleUpdated,
        persistTitle: options.title.persistTitle,
      };
      if (guardedChunkStream) {
        writer.merge(
          interceptTitleChunkStream(
            guardedChunkStream,
            titleDeps,
          ) as Parameters<typeof writer.merge>[0],
        );
        return;
      }
      const intercepted = interceptTitleChunks(guardedChunks!, titleDeps);
      writer.merge(
        asReadableStream(intercepted) as Parameters<typeof writer.merge>[0],
      );
    },
    onStepFinish: ({ responseMessage: rawMessage }) => {
      const responseMessage = withStableId(rawMessage);
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
    onFinish: async ({ responseMessage: rawMessage, finishReason }) => {
      streamFinished = true;
      await Promise.allSettled(pending);
      const responseMessage = withStableId(rawMessage);
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
