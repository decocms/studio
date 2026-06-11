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
 * Re-throws if the source stream errored, AFTER `emitError` has been awaited —
 * so the projector consumer can NAK for redelivery while the error part is
 * already durably written (idempotent on replay).
 */
export async function projectChunks(
  options: ProjectChunksOptions,
): Promise<void> {
  let sourceError: unknown = null;
  const { uiStream, whenComplete } = consumeHarnessStream({
    chunks: options.chunks,
    originalMessages: [],
    title: {
      currentThreadTitle: undefined,
      threadId: "projector",
      persistTitle: async () => {},
    },
    persistence: options.persistence,
    sanitizeErrorText: options.sanitizeErrorText,
    hooks: {
      onError: (error) => {
        sourceError = error;
      },
    },
  });
  await drain(uiStream).catch(() => {});
  await whenComplete;
  if (sourceError !== null) throw sourceError;
}
