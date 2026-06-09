import type { UIMessageChunk, UIMessageStreamWriter } from "ai";

export interface SideChannelWriter {
  writer: UIMessageStreamWriter;
  stream: AsyncIterable<UIMessageChunk>;
  close: () => void;
}

export function createSideChannelWriter(): SideChannelWriter {
  const queue: UIMessageChunk[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    const current = wake;
    wake = null;
    current?.();
  };

  const push = (chunk: UIMessageChunk) => {
    if (closed) return;
    queue.push(chunk);
    notify();
  };

  const stream = (async function* () {
    try {
      while (!closed || queue.length > 0) {
        const chunk = queue.shift();
        if (chunk) {
          yield chunk;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      closed = true;
      notify();
    }
  })();

  return {
    writer: {
      write: (chunk) => push(chunk as UIMessageChunk),
      merge: async (source) => {
        const maybeIterable =
          source as unknown as AsyncIterable<UIMessageChunk>;
        if (typeof maybeIterable[Symbol.asyncIterator] === "function") {
          for await (const chunk of maybeIterable) push(chunk);
          return;
        }
        const reader = (source as ReadableStream<UIMessageChunk>).getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            push(value);
          }
        } finally {
          reader.releaseLock();
        }
      },
      onError: () => {},
    } as UIMessageStreamWriter,
    stream,
    close: () => {
      closed = true;
      notify();
    },
  };
}
