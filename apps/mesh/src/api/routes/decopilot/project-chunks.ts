import type { UIMessageChunk } from "ai";
import {
  consumeHarnessStream,
  type HarnessStreamPersistence,
} from "./consume-harness-stream";

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
  chunks: AsyncIterable<UIMessageChunk>;
  persistence: HarnessStreamPersistence;
  /** Mirrors consumeHarnessStream: shapes the synthesized error part text. */
  sanitizeErrorText?: (error: unknown) => string;
  /**
   * When set, the projector persists the harness title chunk via this writer
   * (it is the sole title writer). Omitted → the title is a no-op (legacy).
   */
  title?: ProjectTitleOptions;
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

/**
 * Pure persistence projection of a raw chunk stream into thread_message_parts
 * (spec §5.4 DB-writer consumer). Reuses the kernel's AI-SDK reassembly +
 * PartEmitter handoff via `consumeHarnessStream`, but discards the live
 * `uiStream` (the UI-tail is a SEPARATE consumer of the NATS log) and ignores
 * title/usage hooks (those run at ingest/UI, not the projector).
 *
 * Re-throws on EITHER failure mode, AFTER persistence has been awaited, so the
 * projector consumer can NAK for redelivery (re-projection is idempotent via
 * PartEmitter's deterministic ids):
 *  - a persistence write failure (emitStepParts/emitFinal/emitError throws).
 *    consumeHarnessStream swallows these (logs them) so the LIVE UI path
 *    survives a DB hiccup — but the durable DB-writer must NOT, or a part is
 *    silently lost. We capture the first such error and re-throw it.
 *  - a source stream error (the chunk iterator threw). The error part is
 *    persisted first; for the projector a throw here is an infra/redelivery
 *    signal, not a "the run failed cleanly" signal (run failures arrive as
 *    `error` data chunks, not exceptions).
 */
export async function projectChunks(
  options: ProjectChunksOptions,
): Promise<void> {
  let sourceError: unknown = null;
  let persistenceError: unknown = null;
  const recordPersistenceError = (error: unknown) => {
    if (persistenceError === null) persistenceError = error;
    throw error; // preserve consumeHarnessStream's own swallow-and-log
  };
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
    chunks: options.chunks,
    originalMessages: [],
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
    hooks: {
      onError: (error) => {
        sourceError = error;
      },
    },
  });
  await drain(uiStream).catch(() => {});
  await whenComplete;
  if (persistenceError !== null) throw persistenceError;
  if (sourceError !== null) throw sourceError;
}
