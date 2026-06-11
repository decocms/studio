import { describe, expect, it } from "bun:test";
import { type Lane, LANE_P1, LANE_P2 } from "./protocol/uplink-frames";
import { compactP2 } from "./uplink-outbox-compaction";

const f = (wireSeq: number, lane: Lane, chunk: unknown) => ({
  wireSeq,
  lane,
  chunk,
});

describe("compactP2", () => {
  it("coalesces adjacent text-delta chunks for the same part id", () => {
    const out = compactP2([
      f(1, LANE_P2, { type: "text-delta", id: "m", delta: "a" }),
      f(2, LANE_P2, { type: "text-delta", id: "m", delta: "b" }),
      f(3, LANE_P2, { type: "text-delta", id: "m", delta: "c" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.chunk).toEqual({
      type: "text-delta",
      id: "m",
      delta: "abc",
    });
    // keeps the HIGHEST wireSeq so the ack cursor still advances correctly
    expect(out[0]!.wireSeq).toBe(3);
  });

  it("never compacts across a P1 chunk (ordering preserved)", () => {
    const out = compactP2([
      f(1, LANE_P2, { type: "text-delta", id: "m", delta: "a" }),
      f(2, LANE_P1, { type: "tool-input-start", id: "t" }),
      f(3, LANE_P2, { type: "text-delta", id: "m", delta: "b" }),
    ]);
    expect(out.map((x) => x.wireSeq)).toEqual([1, 2, 3]);
  });

  it("never drops or merges P0/P1 chunks", () => {
    const input = [
      f(1, LANE_P1, { type: "tool-output-available", id: "t" }),
      f(2, LANE_P1, { type: "done" }),
    ];
    expect(compactP2(input)).toEqual(input);
  });

  it("does not coalesce text-deltas with different part ids", () => {
    const out = compactP2([
      f(1, LANE_P2, { type: "text-delta", id: "a", delta: "x" }),
      f(2, LANE_P2, { type: "text-delta", id: "b", delta: "y" }),
    ]);
    expect(out).toHaveLength(2);
  });
});
