import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import { createProjectorChunkStreamFromMessages } from "./projector-chunk-stream";

const enc = new TextEncoder();

type Msg = {
  subject: string;
  data: Uint8Array;
  headers?: { get(name: string): string | undefined };
};

function msg(
  msgId: string,
  payload: unknown,
  headers?: Record<string, string>,
): Msg {
  const all: Record<string, string> = { "Nats-Msg-Id": msgId, ...headers };
  return {
    subject: "decopilot.stream.run_1",
    data: enc.encode(JSON.stringify(payload)),
    headers: { get: (name) => all[name] },
  };
}

function rawMsg(
  msgId: string,
  raw: string,
  headers?: Record<string, string>,
): Msg {
  const all: Record<string, string> = { "Nats-Msg-Id": msgId, ...headers };
  return {
    subject: "decopilot.stream.run_1",
    data: enc.encode(raw),
    headers: { get: (name) => all[name] },
  };
}

async function readAll(stream: ReadableStream<UIMessageChunk>) {
  const reader = stream.getReader();
  const out: UIMessageChunk[] = [];
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

describe("createProjectorChunkStreamFromMessages", () => {
  test("reads same-fence NATS chunks from seq 1 and closes on matching done", async () => {
    const stream = createProjectorChunkStreamFromMessages({
      messages: [
        msg("run_1:old:1", { p: { type: "start", old: true } }),
        msg("run_1:fence_a:1", { p: { type: "start" } }),
        msg("run_1:fence_a:2", {
          p: { type: "text-delta", id: "t", delta: "hi" },
        }),
        msg("run_1:fence_a:done:2", { done: true, finalSeq: 2 }),
        msg("run_1:fence_a:3", { p: { type: "finish" } }),
      ],
      runId: "run_1",
      fenceToken: "fence_a",
    });

    expect((await readAll(stream)).map((c) => c.type)).toEqual([
      "start",
      "text-delta",
    ]);
  });

  test("ignores legacy unfenced done and closes on the AI SDK finish chunk", async () => {
    const stream = createProjectorChunkStreamFromMessages({
      messages: [
        msg("run_1:fence_a:1", { p: { type: "start" } }),
        msg("run_1:fence_a:2", {
          p: { type: "tool-output-available", toolCallId: "tc", output: {} },
        }),
        msg("", { done: true }),
        msg("run_1:fence_a:3", { p: { type: "start-step" } }),
        msg("run_1:fence_a:4", {
          p: { type: "text-start", id: "t" },
        }),
        msg("run_1:fence_a:5", {
          p: { type: "text-delta", id: "t", delta: "done" },
        }),
        msg("run_1:fence_a:6", { p: { type: "text-end", id: "t" } }),
        msg("run_1:fence_a:7", {
          p: { type: "finish", finishReason: "stop" },
        }),
        msg("run_1:fence_a:8", {
          p: { type: "text-delta", id: "late", delta: "ignored" },
        }),
      ],
      runId: "run_1",
      fenceToken: "fence_a",
    });

    expect((await readAll(stream)).map((c) => c.type)).toEqual([
      "start",
      "tool-output-available",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  test("errors on a gap before done", async () => {
    const stream = createProjectorChunkStreamFromMessages({
      messages: [
        msg("run_1:fence_a:1", { p: { type: "start" } }),
        msg("run_1:fence_a:3", { p: { type: "finish" } }),
        msg("run_1:fence_a:done:3", { done: true, finalSeq: 3 }),
      ],
      runId: "run_1",
      fenceToken: "fence_a",
    });

    await expect(readAll(stream)).rejects.toThrow("missing seq 2");
  });

  test("reassembles fragmented chunks", async () => {
    const full = JSON.stringify({
      p: { type: "text-delta", id: "t", delta: "hello" },
    });
    const stream = createProjectorChunkStreamFromMessages({
      messages: [
        rawMsg("run_1:fence_a:1:frag:0", full.slice(0, 20), {
          "Dp-Frag-Total": "2",
          "Dp-Frag-Idx": "0",
        }),
        rawMsg("run_1:fence_a:1:frag:1", full.slice(20), {
          "Dp-Frag-Total": "2",
          "Dp-Frag-Idx": "1",
        }),
        msg("run_1:fence_a:done:1", { done: true, finalSeq: 1 }),
      ],
      runId: "run_1",
      fenceToken: "fence_a",
    });

    expect(await readAll(stream)).toEqual([
      { type: "text-delta", id: "t", delta: "hello" },
    ]);
  });
});
