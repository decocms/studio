import { describe, expect, it } from "bun:test";
import type { OutboxRow } from "./outbox";
import { outboxRowsToChunkFrames } from "./uplink-frames-from-outbox";

const row = (wireSeq: number, lane: 1 | 2, delta: string): OutboxRow => ({
  runId: "r",
  fenceToken: "f",
  wireSeq,
  lane,
  line: {
    seq: wireSeq,
    event: { type: "ui-message-chunk", chunk: { type: "text-delta", delta } },
  },
  byteLength: 0,
});

describe("outboxRowsToChunkFrames", () => {
  it("maps each row to a chunk frame preserving wireSeq + lane + raw chunk", () => {
    const frames = outboxRowsToChunkFrames([row(1, 2, "a"), row(2, 1, "b")]);
    expect(frames).toEqual([
      {
        type: "chunk",
        runId: "r",
        fenceToken: "f",
        wireSeq: 1,
        lane: 2,
        chunk: {
          type: "ui-message-chunk",
          chunk: { type: "text-delta", delta: "a" },
        },
      },
      {
        type: "chunk",
        runId: "r",
        fenceToken: "f",
        wireSeq: 2,
        lane: 1,
        chunk: {
          type: "ui-message-chunk",
          chunk: { type: "text-delta", delta: "b" },
        },
      },
    ]);
  });

  it("returns an empty array for no rows", () => {
    expect(outboxRowsToChunkFrames([])).toEqual([]);
  });
});
