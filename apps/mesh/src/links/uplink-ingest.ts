/**
 * Cluster-side per-connection uplink ingest state machine (spec §5.3).
 *
 * On each `chunk` frame, in order: validate fence (§10) → dedupe by wireSeq →
 * publish raw chunk to the NATS log → advance the rolling CONTIGUOUS ackSeq
 * (highest wireSeq with all <= it publish-confirmed) → send `{ack, ackSeq}` on
 * the down-channel (§5.3/§8 — ackSeq doubles as the flow-control credit floor).
 *
 * Pure: NATS publish + fence lookup + WS send are injected, so this is a unit
 * (no StudioContext, no NATS) — same testability contract as RelaySessionImpl.
 * P3 chunks are hard-rejected (§5.2 reserved lane).
 */
import type { UIMessageChunk } from "ai";
import {
  type AcceptFrame,
  type ChunkFrame,
  LANE_P3,
} from "./protocol/uplink-frames";

export interface UplinkIngestDeps {
  /** True when the presented fence matches the DB-current run fence (§10). */
  fenceOk: (fenceToken: string) => boolean;
  /** Publish the raw chunk to DECOPILOT_STREAMS; resolves on publish-confirmed. */
  publish: (chunk: UIMessageChunk) => Promise<void>;
  /** Send a down-channel frame to the daemon (ack/cancel/flow/accept). */
  send: (
    frame:
      | AcceptFrame
      | { type: "ack"; runId: string; fenceToken: string; ackSeq: number },
  ) => void;
}

export interface UplinkIngestSession {
  /** Highest contiguous publish-confirmed wireSeq for the active run. */
  readonly ackSeq: number;
  onFrame(frame: ChunkFrame): Promise<void>;
}

export function createUplinkIngestSession(
  deps: UplinkIngestDeps,
): UplinkIngestSession {
  let ackSeq = 0;
  // wireSeqs published but not yet contiguous with ackSeq (out-of-order arrivals).
  const pending = new Set<number>();

  return {
    get ackSeq() {
      return ackSeq;
    },
    async onFrame(frame: ChunkFrame): Promise<void> {
      if (frame.lane === LANE_P3) {
        throw new Error(
          `[uplink-ingest] P3 is a reserved lane; the sender must not emit it (runId=${frame.runId} wireSeq=${frame.wireSeq})`,
        );
      }
      if (!deps.fenceOk(frame.fenceToken)) {
        throw new Error(
          `[uplink-ingest] fence mismatch for runId=${frame.runId}`,
        );
      }
      // Dedupe a replayed prefix: already contiguous-acked → no-op.
      if (frame.wireSeq <= ackSeq) return;
      await deps.publish(frame.chunk as UIMessageChunk);
      pending.add(frame.wireSeq);
      // Advance the contiguous floor as far as the pending set allows.
      while (pending.has(ackSeq + 1)) {
        pending.delete(ackSeq + 1);
        ackSeq += 1;
      }
      deps.send({
        type: "ack",
        runId: frame.runId,
        fenceToken: frame.fenceToken,
        ackSeq,
      });
    },
  };
}
