import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import type { IngestRunDeps } from "./ingest-run";
import { ingestRun } from "./ingest-run";

describe("ingestRun", () => {
  test("dedups replayed seqs (hooks fire once) and publishes each new chunk with msgId", async () => {
    const published: Array<{ chunk: unknown; msgId?: string }> = [];
    const acked: number[] = [];
    let finishCount = 0;
    async function* src() {
      yield { seq: 1, chunk: { type: "text-start", id: "t" } };
      yield { seq: 2, chunk: { type: "text-delta", id: "t", delta: "hi" } };
      yield { seq: 1, chunk: { type: "text-start", id: "t" } }; // replay — must skip
      yield { seq: 3, chunk: { type: "finish" } };
    }
    await ingestRun(
      {
        runId: "r",
        fenceToken: "f",
        chunks: src() as AsyncIterable<{ seq: number; chunk: UIMessageChunk }>,
        onPublished: (s) => acked.push(s),
      },
      {
        streamBuffer: {
          publishRawChunk: async (_id, chunk, opts) => {
            published.push({ chunk, msgId: opts?.msgId });
            return true;
          },
          publishDone: async () => true,
        },
        hooks: {
          onFinish: () => {
            finishCount++;
          },
        },
        title: {
          currentThreadTitle: null,
          threadId: "r",
          persistTitle: async () => {},
        },
      },
    );
    expect(published.map((p) => p.msgId)).toEqual(["r:f:1", "r:f:2", "r:f:3"]); // seq 1 replay skipped
    expect(acked).toEqual([1, 2, 3]);
    expect(finishCount).toBe(1);
  });
});

const chunks = (...items: Array<{ seq: number; chunk: UIMessageChunk }>) =>
  (async function* () {
    for (const item of items) yield item;
  })();

function deps() {
  const published: Array<{ runId: string; chunk: unknown; msgId?: string }> =
    [];
  const done: Array<{ runId: string; fenceToken: string; finalSeq: number }> =
    [];
  return {
    published,
    done,
    deps: {
      streamBuffer: {
        publishRawChunk: async (
          runId: string,
          chunk: unknown,
          opts?: { msgId?: string },
        ) => {
          published.push({ runId, chunk, msgId: opts?.msgId });
          return true;
        },
        publishDone: async (
          runId: string,
          fenceToken: string,
          finalSeq: number,
        ) => {
          done.push({ runId, fenceToken, finalSeq });
          return true;
        },
      },
      hooks: {},
      title: {
        currentThreadTitle: null,
        threadId: "run_1",
        persistTitle: async () => {},
      },
    } satisfies IngestRunDeps,
  };
}

describe("ingestRun done marker", () => {
  test("publishes done with the highest contiguous seq after a clean run", async () => {
    const d = deps();
    await ingestRun(
      {
        runId: "run_1",
        fenceToken: "fence_a",
        chunks: chunks(
          { seq: 1, chunk: { type: "start" } as UIMessageChunk },
          {
            seq: 2,
            chunk: { type: "finish", finishReason: "stop" } as UIMessageChunk,
          },
        ),
      },
      d.deps,
    );

    expect(d.published.map((p) => p.msgId)).toEqual([
      "run_1:fence_a:1",
      "run_1:fence_a:2",
    ]);
    expect(d.done).toEqual([
      { runId: "run_1", fenceToken: "fence_a", finalSeq: 2 },
    ]);
  });

  test("does not publish done when the input stream throws", async () => {
    const d = deps();
    async function* broken() {
      yield { seq: 1, chunk: { type: "start" } as UIMessageChunk };
      throw new Error("source failed");
    }

    await expect(
      ingestRun(
        { runId: "run_1", fenceToken: "fence_a", chunks: broken() },
        d.deps,
      ),
    ).rejects.toThrow("source failed");
    expect(d.done).toEqual([]);
  });
});
