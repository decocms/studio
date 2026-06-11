import { describe, expect, it } from "bun:test";
import { type Lane, LANE_P1, LANE_P2, LANE_P3 } from "./protocol/uplink-frames";
import { createUplinkIngestSession } from "./uplink-ingest";

function session(opts?: { fenceOk?: (t: string) => boolean }) {
  const published: number[] = [];
  const sent: unknown[] = [];
  const s = createUplinkIngestSession({
    fenceOk: opts?.fenceOk ?? (() => true),
    publish: async (_chunk) => {
      published.push(1);
    },
    send: (frame) => {
      sent.push(frame);
    },
  });
  return { s, published, sent };
}

const chunk = (wireSeq: number, lane: Lane = LANE_P2) => ({
  type: "chunk" as const,
  runId: "r",
  fenceToken: "f",
  wireSeq,
  lane,
  chunk: { type: "text-delta", id: "m", delta: "x" },
});

describe("uplink ingest session", () => {
  it("publishes a chunk then advances ackSeq and replies with an ack frame", async () => {
    const { s, published, sent } = session();
    await s.onFrame(chunk(1));
    expect(published.length).toBe(1);
    expect(sent.at(-1)).toEqual({
      type: "ack",
      runId: "r",
      fenceToken: "f",
      ackSeq: 1,
    });
  });

  it("rolling contiguous ackSeq: a gap holds the floor until filled", async () => {
    const { s, sent } = session();
    await s.onFrame(chunk(1));
    await s.onFrame(chunk(3)); // gap at 2 — published but ackSeq stays 1
    expect((sent.at(-1) as { ackSeq: number }).ackSeq).toBe(1);
    await s.onFrame(chunk(2)); // fills the gap → ackSeq jumps to 3
    expect((sent.at(-1) as { ackSeq: number }).ackSeq).toBe(3);
  });

  it("dedupes a replayed prefix (wireSeq <= ackSeq is a no-op publish)", async () => {
    const { s, published } = session();
    await s.onFrame(chunk(1));
    await s.onFrame(chunk(1)); // replay
    expect(published.length).toBe(1);
  });

  it("hard-rejects a P3 chunk (reserved lane) without publishing", async () => {
    const { s, published } = session();
    await expect(s.onFrame(chunk(1, LANE_P3))).rejects.toThrow(/P3/);
    expect(published.length).toBe(0);
  });

  it("accepts P1 and P2 lanes", async () => {
    const { s, published } = session();
    await s.onFrame(chunk(1, LANE_P1));
    await s.onFrame(chunk(2, LANE_P2));
    expect(published.length).toBe(2);
  });

  it("rejects a chunk whose fence fails validation (no publish)", async () => {
    const { s, published } = session({ fenceOk: (t) => t === "other" });
    await expect(s.onFrame(chunk(1))).rejects.toThrow(/fence/i);
    expect(published.length).toBe(0);
  });
});
