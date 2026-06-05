/**
 * Cluster-side CONSUME half of a run, fed by a chunk stream produced elsewhere
 * (the desktop daemon, pushed over the link ingest). Mirrors the
 * `createUIMessageStream` + onStepFinish/onFinish/onError wiring in
 * `dispatch-run.ts`, minus the harness `execute` (the harness ran on the
 * desktop) and the decopilot in-process extras. Assembles chunks into messages
 * and drives the emitter; returns the assembled `uiStream` for the caller to
 * pump into the JetStream live edge.
 */
import { type UIMessageChunk, createUIMessageStream } from "ai";

/**
 * The slice of `PartEmitter` this consumer needs (so it stays unit-testable).
 * Method params mirror `PartEmitter`'s message shape exactly (`role` included
 * so the real `PartEmitter` structurally satisfies this) while keeping `parts`
 * optional so an AI-SDK `responseMessage` (which always has `parts`) is also
 * assignable.
 */
export interface PartEmitterLike {
  emitStepParts(message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts?: unknown[];
  }): Promise<void>;
  emitFinal(message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts?: unknown[];
  }): Promise<void>;
  emitError(messageId: string, errorText: string): Promise<void>;
}

function asReadableStream<T>(it: AsyncIterable<T>): ReadableStream<T> {
  const iter = it[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iter.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iter.return?.(undefined);
    },
  });
}

export interface ConsumePartStreamHooks {
  onStep?: () => void;
  onFinish?: () => void;
  onError?: (error: unknown) => void;
}

export function consumePartStream(
  chunks: AsyncIterable<UIMessageChunk>,
  emitter: PartEmitterLike,
  hooks: ConsumePartStreamHooks = {},
): ReadableStream {
  const pending: Promise<void>[] = [];
  return createUIMessageStream({
    execute: ({ writer }) => {
      writer.merge(
        asReadableStream(chunks) as Parameters<typeof writer.merge>[0],
      );
    },
    onStepFinish: ({ responseMessage }) => {
      pending.push(
        emitter
          .emitStepParts(responseMessage)
          .catch((e) => console.error("[link-ingest] emitStepParts failed", e)),
      );
      hooks.onStep?.();
    },
    onFinish: async ({ responseMessage }) => {
      await Promise.allSettled(pending);
      await emitter
        .emitFinal(responseMessage)
        .catch((e) => console.error("[link-ingest] emitFinal failed", e));
      hooks.onFinish?.();
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : String(error);
      void emitter
        .emitError(crypto.randomUUID(), text)
        .catch((e) => console.error("[link-ingest] emitError failed", e));
      hooks.onError?.(error);
      return text;
    },
  });
}
