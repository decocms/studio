import type { UIMessageChunk } from "ai";
import {
  consumeHarnessStream,
  type HarnessStreamPersistence,
} from "./consume-harness-stream";

export interface ProjectChunksOptions {
  chunks: AsyncIterable<UIMessageChunk>;
  persistence: HarnessStreamPersistence;
  /** Mirrors consumeHarnessStream: shapes the synthesized error part text. */
  sanitizeErrorText?: (error: unknown) => string;
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
    title: {
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
