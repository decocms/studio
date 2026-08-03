import type { UIMessage, UIMessageChunk } from "ai";
import {
  consumeHarnessStream,
  type HarnessStreamPersistence,
  type HarnessUsage,
} from "./consume-harness-stream";
import { isRunStatusControlChunk } from "./run-status-stage";
import { isUserMessageControlChunk } from "./user-message-stream";

/** Transient control chunks that ride the run stream for the live UI but must
 *  never be folded into the durable assistant projection. `fenceFilter`
 *  already drops the fence-less ones, but filtering by type here keeps the
 *  projection correct even if one is ever published with a run fence. */
function isTransientControlChunk(chunk: unknown): boolean {
  return isRunStatusControlChunk(chunk) || isUserMessageControlChunk(chunk);
}

/**
 * Title persistence for the projector. When supplied, the projector becomes the
 * sole writer of `threads.title`: the title-result chunk in the stream is
 * persisted via `persistTitle(runId, title)`. Omitted in non-projector callers
 * (and in the legacy inline path, which keeps its own title interceptor).
 *
 * `currentThreadTitle` is the thread's REAL current title (read from the DB by
 * the projector runtime when the run is resolved). It feeds
 * `interceptTitleChunks`'s gate: the harness title is persisted ONLY when the
 * thread still has the default title ("New chat"). On a thread the user
 * renamed, the gate is closed and the auto-title is NOT applied — so the
 * projector never overwrites a user-set title.
 */
export interface ProjectTitleOptions {
  threadId: string;
  /** The thread's current title at projection time (gates auto-title persist). */
  currentThreadTitle: string | null | undefined;
  persistTitle: (threadId: string, title: string) => Promise<void>;
}

export interface ProjectChunksOptions {
  chunks?: AsyncIterable<UIMessageChunk>;
  chunkStream?: ReadableStream<UIMessageChunk>;
  persistence: HarnessStreamPersistence;
  /** Mirrors consumeHarnessStream: shapes the synthesized error part text. */
  sanitizeErrorText?: (error: unknown) => string;
  /** Deterministic id for a synthesized error message (`error-${runId}`) so
   *  re-projection attempts dedupe it. See consumeHarnessStream. */
  errorMessageId?: string;
  /** Optional override id scheme for the reassembled message(s). Only
   *  background-tool-workflow passes this — its own `${jobId}:msg:${n}` ids. The
   *  decopilot projection paths DO NOT pass it: they keep the harness
   *  `start.messageId` (`msg_…`) verbatim, so a re-fold reads the same id →
   *  identical row ids → ON CONFLICT dedupe. See consumeHarnessStream.generateMessageId. */
  generateMessageId?: () => string;
  /**
   * When set, the projector persists the harness title chunk via this writer
   * (it is the sole title writer). Omitted → the title is a no-op (legacy).
   */
  title?: ProjectTitleOptions;
  /**
   * Prior completed messages to seed createUIMessageStream. Supplied by the
   * persisting projector fold so a continuation merges onto a trailing assistant
   * proposal and the fold resumes from the projection cursor (see
   * consumeHarnessStream). Omitted / empty array → fresh fold from seq 1 (live
   * ingest / non-persisting callers).
   */
  originalMessages?: UIMessage[];
}

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function guardChunkStream<T>(
  source: ReadableStream<T>,
  onError: (error: unknown) => void,
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
      } catch (error) {
        onError(error);
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      release();
    },
  });
}

/** Outcome produced by a clean reconstruction of the chunk stream. */
export interface ProjectChunksResult {
  /**
   * True iff the stream ended with an in-band harness error chunk (the
   * hooks.onError signal fired AND the source generator itself did not throw).
   * A persistence/source THROW is NOT represented here; those still propagate
   * as exceptions so the projector consumer can retry.
   */
  failed: boolean;
  /**
   * The AI-SDK finishReason from the final {type:"finish"} chunk, if present.
   * Observed as `undefined` for harness-error streams (no finish chunk is
   * emitted after the in-band error chunk — Task 4 characterization).
   */
  finishReason?: string;
  usage: Pick<HarnessUsage, "inputTokens" | "outputTokens" | "totalTokens">;
  /**
   * The parts of the LAST assistant message the fold produced, taken directly
   * from the onFinish callback's responseMessage. Used by the workflow's
   * terminal branch to call resolveThreadStatus(finishReason, finalParts) so
   * it can distinguish requires_action (tool-approval pause / pending user_ask)
   * from completed without a round-trip back to the DB.
   */
  finalParts: Array<{ type: string; text?: string; state?: string }>;
}

/**
 * Pure persistence projection of a raw chunk stream into thread_message_parts
 * (spec §5.4 DB-writer consumer). Reuses the kernel's AI-SDK reassembly +
 * PartEmitter handoff via `consumeHarnessStream`, but discards the live
 * `uiStream` (the UI-tail is a SEPARATE consumer of the NATS log). Title and
 * usage are captured here too so the projector is the sole durable writer and
 * terminal analytics source for v2 runs.
 *
 * Returns `{ failed, finishReason, usage }` after a CLEAN reconstruction:
 *  - `failed: true`  — an in-band `{type:"error"}` chunk was the terminal
 *                       signal (harness error verdict; the run must be marked
 *                       failed by the workflow — Task 6).
 *  - `failed: false` — the stream ended with a normal `{type:"finish"}` chunk.
 *
 * Still throws on EITHER failure mode that warrants redelivery:
 *  - a persistence write failure (emitStepParts/emitFinal/emitError throws).
 *    consumeHarnessStream swallows these (logs them) so the LIVE UI path
 *    survives a DB hiccup — but the durable DB-writer must NOT, or a part is
 *    silently lost. We capture the first such error and re-throw it.
 *  - a source stream error (the chunk iterator threw). The error part is
 *    persisted first; for the projector a throw here is an infra/redelivery
 *    signal, not a "the run failed cleanly" signal (run failures arrive as
 *    `error` data chunks, not exceptions).
 *
 * Distinguishing in-band errors from thrown source exceptions (Task 4/5):
 *  Both paths call hooks.onError, but a thrown source exception means the
 *  source AsyncIterable itself threw. We detect this by wrapping the source
 *  generator and tracking whether it threw (sourceThrew). When sourceThrew is
 *  set we re-throw it (infra signal). When inBandErrorSeen=true and
 *  sourceThrew=null the in-band {type:"error"} chunk is the harness verdict;
 *  failed=true only if no terminal {type:"finish"} chunk followed (recovery).
 */
export async function projectChunks(
  options: ProjectChunksOptions,
): Promise<ProjectChunksResult> {
  if (!options.chunks && !options.chunkStream) {
    throw new Error("projectChunks requires chunks or chunkStream");
  }
  // sourceThrew: captures the exception if the source AsyncIterable itself
  // threw (infra/redelivery signal — distinct from an in-band error chunk).
  let sourceThrew: unknown = null;
  // inBandErrorSeen: true iff hooks.onError fired (Task 4 detector).
  // Fires for BOTH thrown-source AND in-band-error paths; sourceThrew
  // disambiguates which one caused it.
  let inBandErrorSeen = false;
  let capturedFinishReason: string | undefined = undefined;
  let capturedUsage: ProjectChunksResult["usage"] = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let capturedFinalParts: ProjectChunksResult["finalParts"] = [];
  let persistenceError: unknown = null;
  const recordPersistenceError = (error: unknown) => {
    if (persistenceError === null) persistenceError = error;
    throw error; // preserve consumeHarnessStream's own swallow-and-log
  };
  // Wrap the source so we can detect a thrown exception at the generator level.
  // An in-band {type:"error"} chunk does NOT cause the generator to throw.
  const wrappedChunks: AsyncIterable<UIMessageChunk> | undefined =
    options.chunks
      ? (async function* () {
          try {
            for await (const chunk of options.chunks!) {
              if (isTransientControlChunk(chunk)) continue;
              yield chunk;
            }
          } catch (e) {
            sourceThrew = e;
            throw e;
          }
        })()
      : undefined;
  const wrappedChunkStream = options.chunkStream
    ? guardChunkStream(options.chunkStream, (error) => {
        sourceThrew = error;
      }).pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          transform(chunk, controller) {
            if (!isTransientControlChunk(chunk)) controller.enqueue(chunk);
          },
        }),
      )
    : undefined;
  // Wrap persistence so a swallowed write failure is still captured here. The
  // re-thrown rejection flows back into consumeHarnessStream's internal
  // `.catch(console.error)`, so its completion semantics are unchanged.
  const persistence: HarnessStreamPersistence = {
    emitStepParts: (message) =>
      options.persistence.emitStepParts(message).catch(recordPersistenceError),
    emitFinal: (message) =>
      options.persistence.emitFinal(message).catch(recordPersistenceError),
    emitError: (id, text) =>
      options.persistence.emitError(id, text).catch(recordPersistenceError),
  };
  const { uiStream, whenComplete } = consumeHarnessStream({
    chunks: wrappedChunks,
    chunkStream: wrappedChunkStream,
    originalMessages: options.originalMessages ?? [],
    // When a title writer is wired, the projector is the sole `threads.title`
    // writer. Pass the thread's REAL current title through to the interceptor's
    // gate: the harness title is persisted only while the thread title is still
    // the default, so a user-renamed thread is never overwritten by the
    // projector. Without a writer, fall back to the inert no-op (legacy).
    title: options.title
      ? {
          currentThreadTitle: options.title.currentThreadTitle,
          threadId: options.title.threadId,
          persistTitle: options.title.persistTitle,
        }
      : {
          currentThreadTitle: undefined,
          threadId: "projector",
          persistTitle: async () => {},
        },
    persistence,
    sanitizeErrorText: options.sanitizeErrorText,
    errorMessageId: options.errorMessageId,
    generateMessageId: options.generateMessageId,
    hooks: {
      onUsage: (totals) => {
        capturedUsage = {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          totalTokens: totals.totalTokens,
        };
      },
      onError: () => {
        // Fires for BOTH in-band {type:"error"} chunks AND thrown source
        // exceptions (both flow through consumeHarnessStream's onError).
        // We use sourceThrew to disambiguate at return time.
        inBandErrorSeen = true;
      },
      onFinish: (message, finishReason) => {
        capturedFinishReason = finishReason;
        // Capture the parts of the last assistant message so the workflow's
        // terminal branch can call resolveThreadStatus(finishReason, finalParts)
        // without a round-trip back to the DB. Filter to well-formed parts only
        // (non-null objects with a "type" property) so malformed entries can't
        // reach resolveThreadStatus — UIMessage.parts is unknown[].
        capturedFinalParts = Array.isArray(message.parts)
          ? (message.parts as unknown[]).filter(
              (p): p is ProjectChunksResult["finalParts"][number] =>
                p != null && typeof p === "object" && "type" in p,
            )
          : [];
      },
    },
  });
  await drain(uiStream).catch(() => {});
  await whenComplete;
  if (persistenceError !== null) throw persistenceError;
  // Re-throw thrown source exceptions (infra/redelivery signal — unchanged).
  if (sourceThrew !== null) throw sourceThrew;
  // Key off the FINAL outcome: a run is failed only when an in-band error was
  // seen AND the stream did NOT reach a natural finish. If capturedFinishReason
  // is set, the error was non-terminal (the run recovered) → not failed.
  const failed = inBandErrorSeen && capturedFinishReason === undefined;
  return {
    failed,
    finishReason: capturedFinishReason,
    usage: capturedUsage,
    finalParts: capturedFinalParts,
  };
}
