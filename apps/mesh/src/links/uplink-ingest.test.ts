import { describe, expect, it } from "bun:test";
import { type Lane, LANE_P1, LANE_P2, LANE_P3 } from "./protocol/uplink-frames";
import { createUplinkIngestSession } from "./uplink-ingest";

function session(opts?: {
  fenceOk?: (t: string) => boolean;
  cancelRequested?: () => boolean;
}) {
  const published: number[] = [];
  const sent: unknown[] = [];
  const s = createUplinkIngestSession({
    fenceOk: opts?.fenceOk ?? (() => true),
    cancelRequested: opts?.cancelRequested,
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

  it("does NOT publish a chunk for a cancelled run; sends a down-channel cancel (NDJSON parity)", async () => {
    const { s, published, sent } = session({ cancelRequested: () => true });
    await s.onFrame(chunk(1));
    expect(published.length).toBe(0);
    expect(sent.at(-1)).toEqual({
      type: "cancel",
      runId: "r",
      fenceToken: "f",
    });
  });
});

const resume = (fenceToken: string, fromSeq = 1) => ({
  type: "resume" as const,
  runId: "r",
  fenceToken,
  fromSeq,
});

describe("uplink resume cursor (fence-scoped)", () => {
  it("accept frame reports the current ackSeq + cancelled:false", async () => {
    const { s, sent } = session();
    await s.onFrame(chunk(1));
    await s.onFrame(chunk(2));
    const accept = await s.onResume(resume("f", 3));
    expect(accept).toEqual({
      type: "accept",
      runId: "r",
      fenceToken: "f",
      ackSeq: 2,
      cancelled: false,
    });
    expect(sent.at(-1)).toEqual(accept);
  });

  it("a new fence epoch resets the cursor to 0", async () => {
    const { s } = session();
    await s.onFrame(chunk(1));
    const accept = await s.onResume(resume("NEW_FENCE"));
    expect(accept.ackSeq).toBe(0);
  });

  it("resume rejects when the fence fails validation", async () => {
    const { s } = session({ fenceOk: (t) => t === "f" });
    await expect(s.onResume(resume("bad"))).rejects.toThrow(/fence/i);
  });

  it("re-asserts cancel on resume when cancel_requested_at is set", async () => {
    const { s, sent } = session({ cancelRequested: () => true });
    await s.onFrame(chunk(1));
    const accept = await s.onResume(resume("f", 2));
    expect(accept.cancelled).toBe(true);
    // accept precedes a down-channel cancel frame.
    expect(sent.at(-1)).toEqual({
      type: "cancel",
      runId: "r",
      fenceToken: "f",
    });
  });
});
