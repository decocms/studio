import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { LinkIngestBatch } from "../api/routes/decopilot/link-ingest-batch-schema";
import { relayDispatchSSEAsPartBatches } from "./link-part-batcher";

function dispatchSSE(chunks: UIMessageChunk[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "ui-message-chunk", chunk })}\n\n`,
          ),
        );
      }
      controller.enqueue(encoder.encode(`data: {"type":"done"}\n\n`));
      controller.close();
    },
  });
}

function errorDispatchSSE(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "error",
            code: "harness_crashed",
            message: "boom",
          })}\n\n`,
        ),
      );
      controller.close();
    },
  });
}

async function relayForTest(input: {
  dispatchBody: ReadableStream<Uint8Array>;
  postBatch: (batch: LinkIngestBatch) => Promise<void>;
}) {
  await relayDispatchSSEAsPartBatches({
    dispatchBody: input.dispatchBody,
    runId: "run_1",
    orgId: "org_1",
    postBatch: input.postBatch,
  });
}

const successfulTextChunks = [
  { type: "start" },
  { type: "start-step" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "hello" },
  { type: "text-end", id: "t1" },
  { type: "finish-step" },
  { type: "finish" },
] as UIMessageChunk[];

describe("relayDispatchSSEAsPartBatches", () => {
  it("posts one rows batch and final done for a successful text stream", async () => {
    const batches: LinkIngestBatch[] = [];

    await relayForTest({
      dispatchBody: dispatchSSE(successfulTextChunks),
      postBatch: async (batch) => {
        batches.push(batch);
      },
    });

    expect(batches).toHaveLength(2);
    expect(batches[0]?.batchId).toBe("run_1:0");
    expect(batches[0]?.done).toBe(false);
    expect(
      batches[0]?.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        payload: row.payload,
      })),
    ).toEqual([
      {
        id: "run_1:0",
        kind: "text",
        payload: expect.objectContaining({ type: "text", text: "hello" }),
      },
      {
        id: "run_1:1",
        kind: "finish",
        payload: {},
      },
    ]);
    expect(batches[1]).toEqual({
      batchId: "run_1:done",
      rows: [],
      done: true,
    });
  });

  it("posts an error row batch and final done for dispatch SSE errors", async () => {
    const batches: LinkIngestBatch[] = [];

    await relayForTest({
      dispatchBody: errorDispatchSSE(),
      postBatch: async (batch) => {
        batches.push(batch);
      },
    });

    expect(batches).toHaveLength(2);
    expect(batches[0]?.batchId).toBe("run_1:0");
    expect(batches[0]?.done).toBe(false);
    expect(batches[0]?.rows.map((row) => [row.id, row.kind])).toEqual([
      ["run_1:0", "error"],
      ["run_1:1", "finish"],
    ]);
    expect(batches[1]).toEqual({
      batchId: "run_1:done",
      rows: [],
      done: true,
    });
  });

  it("rejects and does not post final done when postBatch fails", async () => {
    const batches: LinkIngestBatch[] = [];
    const failure = new Error("handoff failed");

    await expect(
      relayForTest({
        dispatchBody: dispatchSSE(successfulTextChunks),
        postBatch: async (batch) => {
          batches.push(batch);
          if (!batch.done) throw failure;
        },
      }),
    ).rejects.toThrow("handoff failed");

    expect(batches.map((batch) => batch.batchId)).toEqual(["run_1:0"]);
  });

  it("acknowledges successful handoffs so cumulative snapshots do not duplicate rows", async () => {
    const batches: LinkIngestBatch[] = [];
    const chunks = [
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "hello" },
      { type: "text-end", id: "t1" },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: " world" },
      { type: "text-end", id: "t2" },
      { type: "finish-step" },
      { type: "finish" },
    ] as UIMessageChunk[];

    await relayForTest({
      dispatchBody: dispatchSSE(chunks),
      postBatch: async (batch) => {
        batches.push(batch);
      },
    });

    expect(batches.map((batch) => batch.batchId)).toEqual([
      "run_1:0",
      "run_1:1",
      "run_1:done",
    ]);
    expect(batches[0]?.rows.map((row) => row.id)).toEqual(["run_1:0"]);
    expect(batches[1]?.rows.map((row) => row.id)).toEqual([
      "run_1:1",
      "run_1:2",
    ]);
    expect(
      batches
        .filter((batch) => !batch.done)
        .flatMap((batch) => batch.rows.map((row) => row.id)),
    ).toEqual(["run_1:0", "run_1:1", "run_1:2"]);
  });
});
