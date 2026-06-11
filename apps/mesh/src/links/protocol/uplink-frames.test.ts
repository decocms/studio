import { describe, expect, it } from "bun:test";
import {
  LANE_P0,
  LANE_P1,
  LANE_P2,
  LANE_P3,
  laneForChunkType,
  uplinkFrameSchema,
} from "./uplink-frames";

describe("uplinkFrameSchema", () => {
  it("parses a chunk frame round-trip", () => {
    const frame = {
      type: "chunk" as const,
      runId: "run_1",
      fenceToken: "fence_a",
      wireSeq: 1,
      lane: LANE_P2,
      chunk: { type: "text-delta", id: "m1", delta: "hi" },
    };
    const parsed = uplinkFrameSchema.parse(frame);
    expect(parsed).toEqual(frame);
  });

  it("parses hello / resume / accept / ack / cancel / flow", () => {
    expect(
      uplinkFrameSchema.parse({ type: "hello", machineId: "m", protocol: 2 })
        .type,
    ).toBe("hello");
    expect(
      uplinkFrameSchema.parse({
        type: "resume",
        runId: "r",
        fenceToken: "f",
        fromSeq: 5,
      }).type,
    ).toBe("resume");
    expect(
      uplinkFrameSchema.parse({
        type: "accept",
        runId: "r",
        fenceToken: "f",
        ackSeq: 3,
        cancelled: false,
      }).type,
    ).toBe("accept");
    expect(
      uplinkFrameSchema.parse({
        type: "ack",
        runId: "r",
        fenceToken: "f",
        ackSeq: 7,
      }).type,
    ).toBe("ack");
    expect(
      uplinkFrameSchema.parse({ type: "cancel", runId: "r", fenceToken: "f" })
        .type,
    ).toBe("cancel");
    expect(
      uplinkFrameSchema.parse({
        type: "flow",
        lane: LANE_P2,
        maxInFlightBytes: 1000,
      }).type,
    ).toBe("flow");
  });

  it("rejects wireSeq <= 0 and an unknown frame type", () => {
    expect(
      uplinkFrameSchema.safeParse({
        type: "chunk",
        runId: "r",
        fenceToken: "f",
        wireSeq: 0,
        lane: LANE_P1,
        chunk: {},
      }).success,
    ).toBe(false);
    expect(uplinkFrameSchema.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("maps chunk.type to the correct lane (tag-switch, never folds)", () => {
    expect(laneForChunkType("text-delta")).toBe(LANE_P2);
    expect(laneForChunkType("reasoning-delta")).toBe(LANE_P2);
    expect(laneForChunkType("data-progress")).toBe(LANE_P2);
    expect(laneForChunkType("tool-input-start")).toBe(LANE_P1);
    expect(laneForChunkType("tool-output-available")).toBe(LANE_P1);
    expect(laneForChunkType("start")).toBe(LANE_P1);
    expect(laneForChunkType("finish")).toBe(LANE_P1);
    expect(laneForChunkType("error")).toBe(LANE_P1);
    expect(laneForChunkType("done")).toBe(LANE_P1);
  });

  it("never assigns P0 or P3 from a chunk type", () => {
    for (const t of ["text-delta", "tool-input-start", "done", "unknown-x"]) {
      const lane = laneForChunkType(t);
      expect(lane).not.toBe(LANE_P0);
      expect(lane).not.toBe(LANE_P3);
    }
  });

  it("defaults an unknown chunk type to P1 (never-drop), not P2", () => {
    expect(laneForChunkType("totally-new-chunk-kind")).toBe(LANE_P1);
  });
});
