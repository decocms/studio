import { describe, expect, it } from "bun:test";
import { processAckFrame } from "./uplink-ack-cursor";

describe("processAckFrame", () => {
  it("advances on a higher ackSeq", () => {
    const r = processAckFrame({ ackSeq: 0, maxSentWireSeq: 10 }, 5);
    expect(r.advanced).toBe(true);
    expect(r.newState).toEqual({ ackSeq: 5, maxSentWireSeq: 10 });
  });

  it("ignores a regressing or duplicate ackSeq (no-op)", () => {
    const cur = { ackSeq: 5, maxSentWireSeq: 10 };
    expect(processAckFrame(cur, 5).advanced).toBe(false);
    expect(processAckFrame(cur, 3).advanced).toBe(false);
    expect(processAckFrame(cur, 3).newState).toEqual(cur);
  });

  it("advances from 0 on the first ack", () => {
    expect(processAckFrame({ ackSeq: 0, maxSentWireSeq: 1 }, 1).advanced).toBe(
      true,
    );
  });
});
