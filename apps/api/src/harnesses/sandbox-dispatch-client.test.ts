import { describe, expect, test } from "bun:test";
import {
  harnessRunsInSandbox,
  readDispatchSSE,
} from "./sandbox-dispatch-client";

/** Build the daemon's SSE wire from raw frame bodies. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function dataFrame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of readDispatchSSE(stream, signal)) out.push(chunk);
  return out;
}

describe("harnessRunsInSandbox", () => {
  test("claude-code is sandbox-hosted", () => {
    expect(harnessRunsInSandbox("claude-code")).toBe(true);
  });

  test("decopilot is not — it runs in-process", () => {
    expect(harnessRunsInSandbox("decopilot")).toBe(false);
  });
});

describe("readDispatchSSE", () => {
  test("yields chunks and stops at done", async () => {
    const chunks = await collect(
      sseStream([
        ": dispatch accepted\n\n",
        dataFrame({ type: "ui-message-chunk", chunk: { type: "start" } }),
        dataFrame({
          type: "ui-message-chunk",
          chunk: { type: "text-delta", id: "1", delta: "hi" },
        }),
        dataFrame({ type: "done" }),
      ]),
    );
    expect(chunks).toEqual([
      { type: "start" },
      { type: "text-delta", id: "1", delta: "hi" },
    ]);
  });

  test("ignores anything after done", async () => {
    const chunks = await collect(
      sseStream([
        dataFrame({ type: "done" }),
        dataFrame({ type: "ui-message-chunk", chunk: { type: "start" } }),
      ]),
    );
    expect(chunks).toEqual([]);
  });

  test("reassembles frames split across reads", async () => {
    // One logical frame arriving in three network chunks.
    const chunks = await collect(
      sseStream([
        'data: {"type":"ui-message-chunk","chunk":',
        '{"type":"text-delta","id":"1","delta":"split"}}',
        "\n\n" + dataFrame({ type: "done" }),
      ]),
    );
    expect(chunks).toEqual([{ type: "text-delta", id: "1", delta: "split" }]);
  });

  test("handles several frames delivered in one read", async () => {
    const chunks = await collect(
      sseStream([
        dataFrame({ type: "ui-message-chunk", chunk: { type: "start-step" } }) +
          dataFrame({
            type: "ui-message-chunk",
            chunk: { type: "finish-step" },
          }) +
          dataFrame({ type: "done" }),
      ]),
    );
    expect(chunks).toEqual([{ type: "start-step" }, { type: "finish-step" }]);
  });

  test("an error event throws with code and message", async () => {
    await expect(
      collect(
        sseStream([
          dataFrame({
            type: "error",
            code: "harness_crashed",
            message: "boom",
          }),
        ]),
      ),
    ).rejects.toThrow("harness_crashed: boom");
  });

  test("an error after partial output still throws", async () => {
    const stream = sseStream([
      dataFrame({ type: "ui-message-chunk", chunk: { type: "start" } }),
      dataFrame({ type: "error", code: "harness_crashed", message: "late" }),
    ]);
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const chunk of readDispatchSSE(stream)) seen.push(chunk);
      })(),
    ).rejects.toThrow("late");
    expect(seen).toEqual([{ type: "start" }]);
  });

  test("a stream that ends without done is a crash, not a clean finish", async () => {
    await expect(
      collect(
        sseStream([
          dataFrame({ type: "ui-message-chunk", chunk: { type: "start" } }),
        ]),
      ),
    ).rejects.toThrow("ended before done");
  });

  test("malformed and unknown frames are skipped, not fatal", async () => {
    const chunks = await collect(
      sseStream([
        "data: {not json\n\n",
        dataFrame({ type: "something-new", foo: 1 }),
        dataFrame({ type: "ui-message-chunk", chunk: { type: "start" } }),
        dataFrame({ type: "done" }),
      ]),
    );
    expect(chunks).toEqual([{ type: "start" }]);
  });

  test("an aborted signal ends the stream without demanding done", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await collect(sseStream([]), controller.signal)).toEqual([]);
  });
});
