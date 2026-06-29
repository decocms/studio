// apps/mesh/src/api/routes/decopilot/nats-chunk-source.test.ts
import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { natsChunkSource, concat, type RawMsg } from "./nats-chunk-source";

const enc = new TextEncoder();

function raw(
  msgId: string | null,
  body: string,
  headers?: Record<string, string>,
): RawMsg {
  const all: Record<string, string> = {
    ...(msgId !== null ? { "Nats-Msg-Id": msgId } : {}),
    ...headers,
  };
  return {
    subject: "decopilot.stream.run_1",
    data: enc.encode(body),
    headers: { get: (n) => all[n] },
  };
}
function rawJson(
  msgId: string | null,
  payload: unknown,
  headers?: Record<string, string>,
): RawMsg {
  return raw(msgId, JSON.stringify(payload), headers);
}
async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const out: T[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

describe("concat", () => {
  test("joins byte slices in order", () => {
    const merged = concat([
      enc.encode("ab"),
      enc.encode("c"),
      enc.encode("de"),
    ]);
    expect(new TextDecoder().decode(merged)).toBe("abcde");
  });
});

describe("natsChunkSource", () => {
  test("passes through raw messages and closes when the iterable ends", async () => {
    const src = natsChunkSource({
      messages: [rawJson("run_1:fence_a:1", { p: { type: "start" } })],
    });
    const out = await readAll(src);
    expect(out.map((m) => new TextDecoder().decode(m.data))).toEqual([
      JSON.stringify({ p: { type: "start" } }),
    ]);
  });

  test("calls onCancel when the stream is cancelled", async () => {
    let cancelled = false;
    async function* never(): AsyncIterable<RawMsg> {
      // yields one then awaits forever
      yield rawJson("run_1:fence_a:1", { p: { type: "start" } });
      await new Promise(() => {});
    }
    const src = natsChunkSource({
      messages: never(),
      onCancel: () => {
        cancelled = true;
      },
    });
    const reader = src.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  test("errors when no output is produced before the idle timeout", async () => {
    async function* silent(): AsyncIterable<RawMsg> {
      await new Promise(() => {}); // never yields
    }
    const src = natsChunkSource({ messages: silent(), idleTimeoutMs: 10 });
    await expect(readAll(src)).rejects.toThrow(
      "producer produced no output before timeout",
    );
  });
});
