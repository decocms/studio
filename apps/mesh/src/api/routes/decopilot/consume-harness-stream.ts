import { type UIMessage, type UIMessageChunk, createUIMessageStream } from "ai";
import { interceptTitleChunks } from "./title-interceptor";

export interface HarnessStreamPersistence {
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

export interface HarnessStreamConsumerHooks {
  onStep?: (message: UIMessage) => void | Promise<void>;
  onFinish?: (message: UIMessage) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
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

export function consumeHarnessStream(options: ConsumeHarnessStreamOptions): {
  uiStream: ReadableStream;
  whenComplete: Promise<void>;
  isStreamFinished: () => boolean;
} {
  const pending: Promise<void>[] = [];
  let streamFinished = false;
  let errored = false;
  const errorMessageId = crypto.randomUUID();
  let resolveComplete!: () => void;
  const whenComplete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });

  const uiStream = createUIMessageStream({
    originalMessages: options.originalMessages,
    execute: ({ writer }) => {
      const intercepted = interceptTitleChunks(options.chunks, {
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
        options.persistence
          .emitStepParts(responseMessage)
          .catch((e) =>
            console.error("[consume-harness-stream] emitStepParts failed", e),
          ),
      );
      pending.push(
        Promise.resolve(options.hooks?.onStep?.(responseMessage)).catch((e) =>
          console.error("[consume-harness-stream] onStep hook failed", e),
        ),
      );
    },
    onFinish: async ({ responseMessage }) => {
      streamFinished = true;
      await Promise.allSettled(pending);
      if (!errored) {
        await options.persistence
          .emitFinal(responseMessage)
          .catch((e) =>
            console.error("[consume-harness-stream] emitFinal failed", e),
          );
      }
      await Promise.resolve(options.hooks?.onFinish?.(responseMessage)).catch(
        (e) =>
          console.error("[consume-harness-stream] onFinish hook failed", e),
      );
      resolveComplete();
    },
    onError: (error) => {
      streamFinished = true;
      const text = error instanceof Error ? error.message : String(error);
      if (!errored) {
        errored = true;
        pending.push(
          options.persistence
            .emitError(errorMessageId, text)
            .catch((e) =>
              console.error("[consume-harness-stream] emitError failed", e),
            ),
        );
        pending.push(
          Promise.resolve(options.hooks?.onError?.(error)).catch((e) =>
            console.error("[consume-harness-stream] onError hook failed", e),
          ),
        );
      }
      return text;
    },
  });

  return {
    uiStream,
    whenComplete,
    isStreamFinished: () => streamFinished,
  };
}
