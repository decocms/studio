/**
 * Ack frame → truncation cursor (pure). When the cluster sends `ack{ackSeq}`,
 * rows 1..ackSeq are durably published, so the daemon can truncate them
 * (outbox.truncateUpToSeq). Acks are a monotonic rolling floor — a regressing
 * or duplicate ackSeq is a no-op so we never un-truncate or churn.
 */
export interface AckCursorState {
  /** Highest ackSeq received from the cluster (publish-confirmed floor). */
  ackSeq: number;
  /** Highest wireSeq sent (ackSeq <= maxSentWireSeq always). */
  maxSentWireSeq: number;
}

export function processAckFrame(
  current: AckCursorState,
  ackSeq: number,
): { advanced: boolean; newState: AckCursorState } {
  if (ackSeq <= current.ackSeq) {
    return { advanced: false, newState: current };
  }
  return {
    advanced: true,
    newState: { ackSeq, maxSentWireSeq: current.maxSentWireSeq },
  };
}
