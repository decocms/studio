/**
 * Uplink / outbox metric names + pure derivations (§13).
 *
 * The WS uplink emit sites land with the WS-transport migration step; this
 * module pins the canonical metric names and the side-effect-free math so
 * dashboards and the emit sites agree. `lane_drops{lane}` MUST stay 0 for
 * P0/P1 (control + tool/terminal lanes are never dropped); only P2
 * (text/reasoning deltas) may compact.
 */
export const UPLINK_METRIC_NAMES = {
  outboxDepth: "link.outbox.depth",
  oldestUnackedAge: "link.outbox.oldest_unacked_age",
  ackLag: "link.uplink.acklag",
  laneDrops: "link.uplink.lane_drops",
  compactedDeltas: "link.uplink.compacted_deltas",
  consumerRedeliveries: "consumer.redeliveries",
  consumerDlq: "consumer.dlq",
} as const;

export type UplinkMetricName =
  (typeof UPLINK_METRIC_NAMES)[keyof typeof UPLINK_METRIC_NAMES];

/** `acklag = maxSentWireSeq − ackSeq`, floored at 0. */
export function computeAckLag(args: {
  maxSentWireSeq: number;
  ackSeq: number;
}): number {
  return Math.max(0, args.maxSentWireSeq - args.ackSeq);
}

/** Age of the oldest still-unacked outbox row; 0 when nothing is unacked. */
export function computeOldestUnackedAgeMs(args: {
  now: number;
  oldestUnackedAt: number | null;
}): number {
  if (args.oldestUnackedAt === null) return 0;
  return Math.max(0, args.now - args.oldestUnackedAt);
}
