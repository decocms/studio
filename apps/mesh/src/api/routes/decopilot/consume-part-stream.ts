/**
 * Cluster-side CONSUME half of a run, fed by a chunk stream produced elsewhere
 * (the desktop daemon, pushed over the link ingest). Mirrors the
 * `createUIMessageStream` + onStepFinish/onFinish/onError wiring in
 * `dispatch-run.ts`, minus the harness `execute` and the decopilot in-process
 * extras. Assembles chunks into messages, drives the emitter, and returns both
 * the assembled `uiStream` (for the caller to pump into the JetStream live
 * edge) and a `whenComplete` promise the caller awaits to know all durable
 * parts have been committed — instead of inferring completion from drain timing
 * (which is unsound on the error path, since the SDK invokes `onError`
 * synchronously, outside the stream's flush).
 */
import { type UIMessageChunk, createUIMessageStream } from "ai";

/**
 * The slice of `PartEmitter` this consumer needs (so it stays unit-testable).
 * Method params mirror `PartEmitter`'s message shape exactly (`role` included)
 * so the real `PartEmitter` structurally satisfies this and an AI-SDK
 * `responseMessage` is assignable.
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

export interface ConsumePartStreamHooks {
  onStep?: () => void;
  onFinish?: () => void;
  onError?: (error: unknown) => void;
}

export interface ConsumePartStreamResult {
  /**
   * The assembled UI message stream. The caller MUST consume it (pump/drain)
   * for the run to make progress and for `whenComplete` to resolve.
   */
  uiStream: ReadableStream;
  /**
   * Resolves after the terminal durable emit has settled — `emitFinal` on
   * success, or `emitError` on failure. The caller awaits this to know all
   * parts are committed, rather than inferring completion from drain timing.
   */
  whenComplete: Promise<void>;
}

export function consumePartStream(
  chunks: AsyncIterable<UIMessageChunk>,
  emitter: PartEmitterLike,
  hooks: ConsumePartStreamHooks = {},
): ConsumePartStreamResult {
  const pending: Promise<void>[] = [];
  // One desktop error surfaces `onError` MORE THAN ONCE (writer.merge's catch
  // formats the error, AND the resulting error chunk re-enters the transform).
  // Guard so exactly one error part is written, under one stable message id.
  let errored = false;
  const errorMessageId = crypto.randomUUID();
  let resolveComplete!: () => void;
  const whenComplete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });

  const uiStream = createUIMessageStream({
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
    // onFinish runs inside the stream's flush() — the SDK awaits it before the
    // readable closes — so awaiting the terminal emits here makes `whenComplete`
    // a sound "all parts committed" signal. onFinish runs even on the error
    // path, so `whenComplete` always resolves once the stream is consumed.
    onFinish: async ({ responseMessage }) => {
      await Promise.allSettled(pending);
      if (!errored) {
        await emitter
          .emitFinal(responseMessage)
          .catch((e) => console.error("[link-ingest] emitFinal failed", e));
      }
      hooks.onFinish?.();
      resolveComplete();
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : String(error);
      if (!errored) {
        errored = true;
        // NOT awaited here (the SDK calls onError synchronously); pushed into
        // `pending` so onFinish's `Promise.allSettled(pending)` waits for the
        // error part to commit before `whenComplete` resolves (fixes C1).
        pending.push(
          emitter
            .emitError(errorMessageId, text)
            .catch((e) => console.error("[link-ingest] emitError failed", e)),
        );
        hooks.onError?.(error);
      }
      return text;
    },
  });

  return { uiStream, whenComplete };
}
