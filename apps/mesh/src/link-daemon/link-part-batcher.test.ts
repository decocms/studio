import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { LinkIngestBatch } from "../api/routes/decopilot/link-ingest-batch-schema";
import { relayDispatchSSEAsPartBatches } from "./link-part-batcher";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function multiStepChunks(count: number): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [{ type: "start" } as UIMessageChunk];
  for (let i = 0; i < count; i++) {
    chunks.push(
      { type: "start-step" } as UIMessageChunk,
      { type: "text-start", id: `t${i}` } as UIMessageChunk,
      { type: "text-delta", id: `t${i}`, delta: `part ${i}` } as UIMessageChunk,
      { type: "text-end", id: `t${i}` } as UIMessageChunk,
      { type: "finish-step" } as UIMessageChunk,
    );
  }
  chunks.push({ type: "finish" } as UIMessageChunk);
  return chunks;
}

function manyTextPartsInOneStep(count: number): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [
    { type: "start" } as UIMessageChunk,
    { type: "start-step" } as UIMessageChunk,
  ];
  for (let i = 0; i < count; i++) {
    chunks.push(
      { type: "text-start", id: `t${i}` } as UIMessageChunk,
      { type: "text-delta", id: `t${i}`, delta: `part ${i}` } as UIMessageChunk,
      { type: "text-end", id: `t${i}` } as UIMessageChunk,
    );
  }
  chunks.push(
    { type: "finish-step" } as UIMessageChunk,
    { type: "finish" } as UIMessageChunk,
  );
  return chunks;
}

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

  it("serializes slow postBatch calls so overlapping step callbacks do not duplicate row ids", async () => {
    const batches: LinkIngestBatch[] = [];
    const firstPostStarted = deferred();
    const releaseFirstPost = deferred();
    let firstNonDone = true;

    const relayPromise = relayForTest({
      dispatchBody: dispatchSSE(multiStepChunks(3)),
      postBatch: async (batch) => {
        batches.push(batch);
        if (!batch.done && firstNonDone) {
          firstNonDone = false;
          firstPostStarted.resolve();
          await releaseFirstPost.promise;
        }
      },
    });

    await firstPostStarted.promise;
    await Promise.resolve();
    expect(batches.map((batch) => batch.batchId)).toEqual(["run_1:0"]);

    releaseFirstPost.resolve();
    await relayPromise;

    expect(batches.map((batch) => batch.batchId)).toEqual([
      "run_1:0",
      "run_1:1",
      "run_1:2",
      "run_1:done",
    ]);
    const rowIds = batches
      .filter((batch) => !batch.done)
      .flatMap((batch) => batch.rows.map((row) => row.id));
    expect(rowIds).toEqual(["run_1:0", "run_1:1", "run_1:2", "run_1:3"]);
    expect(new Set(rowIds).size).toBe(rowIds.length);
  });

  it("splits more than 512 rows into multiple non-done batches before final done", async () => {
    const batches: LinkIngestBatch[] = [];

    await relayForTest({
      dispatchBody: dispatchSSE(manyTextPartsInOneStep(513)),
      postBatch: async (batch) => {
        batches.push(batch);
      },
    });

    expect(batches.map((batch) => batch.batchId)).toEqual([
      "run_1:0",
      "run_1:1",
      "run_1:done",
    ]);
    expect(batches[0]?.done).toBe(false);
    expect(batches[1]?.done).toBe(false);
    expect(batches[0]?.rows).toHaveLength(512);
    expect(batches[1]?.rows).toHaveLength(2);
    expect(batches[0]?.rows.length).toBeLessThanOrEqual(512);
    expect(batches[1]?.rows.length).toBeLessThanOrEqual(512);
    expect(batches[2]).toEqual({
      batchId: "run_1:done",
      rows: [],
      done: true,
    });
  });

  it("rejects and does not post final done when a later split chunk fails", async () => {
    const batches: LinkIngestBatch[] = [];

    await expect(
      relayForTest({
        dispatchBody: dispatchSSE(manyTextPartsInOneStep(513)),
        postBatch: async (batch) => {
          batches.push(batch);
          if (batch.batchId === "run_1:1") {
            throw new Error("second chunk failed");
          }
        },
      }),
    ).rejects.toThrow("second chunk failed");

    expect(batches.map((batch) => batch.batchId)).toEqual([
      "run_1:0",
      "run_1:1",
    ]);
  });
});
