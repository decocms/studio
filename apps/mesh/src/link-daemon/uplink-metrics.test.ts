import { describe, expect, test } from "bun:test";
import {
  computeAckLag,
  computeOldestUnackedAgeMs,
  UPLINK_METRIC_NAMES,
} from "./uplink-metrics";

describe("UPLINK_METRIC_NAMES", () => {
  test("declares the §13 counter names", () => {
    expect(UPLINK_METRIC_NAMES).toEqual({
      outboxDepth: "link.outbox.depth",
      oldestUnackedAge: "link.outbox.oldest_unacked_age",
      ackLag: "link.uplink.acklag",
      laneDrops: "link.uplink.lane_drops",
      compactedDeltas: "link.uplink.compacted_deltas",
      consumerRedeliveries: "consumer.redeliveries",
      consumerDlq: "consumer.dlq",
    });
  });
});

describe("computeAckLag", () => {
  test("maxSentWireSeq − ackSeq", () => {
    expect(computeAckLag({ maxSentWireSeq: 100, ackSeq: 80 })).toBe(20);
  });
  test("never negative (ack cannot outrun send)", () => {
    expect(computeAckLag({ maxSentWireSeq: 5, ackSeq: 9 })).toBe(0);
  });
  test("zero when fully acked", () => {
    expect(computeAckLag({ maxSentWireSeq: 42, ackSeq: 42 })).toBe(0);
  });
});

describe("computeOldestUnackedAgeMs", () => {
  test("now − oldest unacked createdAt", () => {
    expect(
      computeOldestUnackedAgeMs({ now: 10_000, oldestUnackedAt: 7_000 }),
    ).toBe(3_000);
  });
  test("null oldest (nothing unacked) → 0", () => {
    expect(
      computeOldestUnackedAgeMs({ now: 10_000, oldestUnackedAt: null }),
    ).toBe(0);
  });
});
