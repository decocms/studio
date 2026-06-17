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

describe("ingestRun onPublished contiguous floor", () => {
  test("out-of-order input: onPublished fires with the contiguous floor, not the raw seq", async () => {
    // Deliver chunks out of order: 1, 3, 2.
    // Expected floor progression:
    //   seq=1 published → ackSeq 0→1 → onPublished(1)
    //   seq=3 published → ackSeq stays 1 → no onPublished (gap at 2)
    //   seq=2 published → ackSeq 1→2→3 → onPublished(3) (floor jumps to 3)
    const acked: number[] = [];
    async function* outOfOrder() {
      yield {
        seq: 1,
        chunk: { type: "text-start", id: "t" } as UIMessageChunk,
      };
      yield {
        seq: 3,
        chunk: { type: "finish", finishReason: "stop" } as UIMessageChunk,
      };
      yield {
        seq: 2,
        chunk: { type: "text-delta", id: "t", delta: "hi" } as UIMessageChunk,
      };
    }
    const d = deps();
    await ingestRun(
      {
        runId: "run_1",
        fenceToken: "fence_a",
        chunks: outOfOrder(),
        onPublished: (s) => acked.push(s),
      },
      d.deps,
    );
    // onPublished fires ONLY when the contiguous floor advances:
    //   - after seq=1: floor=1 → onPublished(1)
    //   - after seq=3: floor stays 1 → no call
    //   - after seq=2: floor jumps to 3 → onPublished(3)
    expect(acked).toEqual([1, 3]);
    // publishDone should use the final contiguous floor = 3
    expect(d.done).toEqual([
      { runId: "run_1", fenceToken: "fence_a", finalSeq: 3 },
    ]);
  });
});

describe("ingestRun initialAckSeq resume floor", () => {
  test("with initialAckSeq=3, skips publishing seqs 1-3 and publishes only 4,5,6 with correct msgIds, fires onPublished for advancing floor, publishDone carries finalSeq=6", async () => {
    // Scenario: prior session already published seqs 1-3 to JetStream. A pod
    // restart opens a fresh relay session (lastSeq=0) which delivers the FULL
    // prefix 1..6. ingestRun with initialAckSeq=3 must skip publishing 1-3
    // (already in JetStream, same msgIds) and publish only 4,5,6.
    const d = deps();
    const acked: number[] = [];
    await ingestRun(
      {
        runId: "run_1",
        fenceToken: "fence_a",
        initialAckSeq: 3,
        chunks: chunks(
          // seqs 1-3: already-published prefix — must be SKIPPED (no publish, no yield to kernel)
          { seq: 1, chunk: { type: "start" } as UIMessageChunk },
          { seq: 2, chunk: { type: "start-step" } as UIMessageChunk },
          { seq: 3, chunk: { type: "finish-step" } as UIMessageChunk },
          // seqs 4-6: new tail — must be PUBLISHED
          { seq: 4, chunk: { type: "start" } as UIMessageChunk },
          { seq: 5, chunk: { type: "start-step" } as UIMessageChunk },
          {
            seq: 6,
            chunk: { type: "finish", finishReason: "stop" } as UIMessageChunk,
          },
        ),
        onPublished: (s) => acked.push(s),
      },
      d.deps,
    );

    // Only seqs 4, 5, 6 were published — 1-3 were skipped as already-acked prefix.
    expect(d.published.map((p) => p.msgId)).toEqual([
      "run_1:fence_a:4",
      "run_1:fence_a:5",
      "run_1:fence_a:6",
    ]);
    // onPublished fires only when the contiguous floor advances past the initial 3.
    expect(acked).toEqual([4, 5, 6]);
    // publishDone carries the final contiguous seq = 6.
    expect(d.done).toEqual([
      { runId: "run_1", fenceToken: "fence_a", finalSeq: 6 },
    ]);
  });
});

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
