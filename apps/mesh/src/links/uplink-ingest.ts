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
      | { type: "ack"; runId: string; fenceToken: string; ackSeq: number }
      | { type: "cancel"; runId: string; fenceToken: string },
  ) => void;
  /**
   * True when `cancel_requested_at` is set for the run — re-checked per
   * (re)connect so a cancel issued while the daemon was offline is re-asserted
   * on the `accept` frame (§8, B3 backstop). Optional; defaults to never.
   */
  cancelRequested?: () => boolean;
}

export interface UplinkIngestSession {
  /** Highest contiguous publish-confirmed wireSeq for the active run. */
  readonly ackSeq: number;
  onFrame(frame: ChunkFrame): Promise<void>;
  /**
   * Handle a `resume`/`hello` reconnect: validate the fence, reset the cursor on
   * a new fence epoch (N6), reply `accept{ackSeq, cancelled}` BEFORE any chunk,
   * and re-assert a pending cancel down-channel.
   */
  onResume(frame: {
    runId: string;
    fenceToken: string;
    fromSeq: number;
  }): Promise<AcceptFrame>;
}

export function createUplinkIngestSession(
  deps: UplinkIngestDeps,
): UplinkIngestSession {
  let ackSeq = 0;
  // The active fence epoch — seeded by the first chunk/resume; a change resets
  // the cursor (fence-scoped resume, spec N6).
  let fence: string | null = null;
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
      if (fence === null) fence = frame.fenceToken;
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
    async onResume(frame): Promise<AcceptFrame> {
      if (!deps.fenceOk(frame.fenceToken)) {
        throw new Error(
          `[uplink-ingest] fence mismatch on resume for runId=${frame.runId}`,
        );
      }
      // Fence-scoped cursor (N6): a new epoch resets the floor to 0.
      if (fence !== null && fence !== frame.fenceToken) {
        ackSeq = 0;
        pending.clear();
      }
      fence = frame.fenceToken;
      const cancelled = deps.cancelRequested?.() ?? false;
      const accept: AcceptFrame = {
        type: "accept",
        runId: frame.runId,
        fenceToken: frame.fenceToken,
        ackSeq,
        cancelled,
      };
      deps.send(accept);
      // Re-assert a pending cancel down-channel (B3 backstop): the daemon may
      // have been offline when the user cancelled, so the accept's `cancelled`
      // flag is followed by an explicit cancel frame to abort the run.
      if (cancelled) {
        deps.send({
          type: "cancel",
          runId: frame.runId,
          fenceToken: frame.fenceToken,
        });
      }
      return accept;
    },
  };
}
