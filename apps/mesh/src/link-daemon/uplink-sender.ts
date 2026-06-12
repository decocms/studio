/**
 * Daemon-side WS uplink sender (return-leg, spec §5.3) — the state machine that
 * replaces the streaming-POST relay. Composes the pure cores
 * (uplink-frames-from-outbox, uplink-ack-cursor, outbox rolling truncation,
 * uplink-token-ttl). The WebSocket transport + reconnect/backoff + token-refresh
 * timer are the integration shell; this object is the testable core driven by an
 * injected `send` (up-channel) + `onFrame` (down-channel ack/accept/cancel).
 *
 * Protocol: on `start()` send `hello{bearer}` (a FRESH token via getAccessToken
 * — never the pinned startup token, the Expected-101 fix) then replay the
 * outbox's unacked tail as chunk frames. On `ack{ackSeq}` truncate the acked
 * prefix + advance the cursor. On `accept{ackSeq,cancelled}` (reconnect) resume
 * from ackSeq+1; a cancelled accept (or a `cancel` frame) aborts the run.
 */
import type { UplinkFrame } from "../links/protocol/uplink-frames";
import { type AckCursorState, processAckFrame } from "./uplink-ack-cursor";
import { outboxRowsToChunkFrames } from "./uplink-frames-from-outbox";
import type { Outbox } from "./outbox";

const PROTOCOL_VERSION = 2;

export interface UplinkSenderDeps {
  runId: string;
  fenceToken: string;
  machineId: string;
  outbox: Outbox;
  /** Fresh bearer per (re)connect — NOT the pinned startup token. */
  getAccessToken: () => Promise<string>;
  /** Send one frame up-channel (the WS socket in prod). */
  send: (frame: UplinkFrame) => void;
  /** Abort the local run (cancel down-channel or cancelled accept). */
  onCancel: () => void;
}

export interface UplinkSender {
  /** (Re)open: send hello{fresh bearer} then replay the unacked tail. */
  start(): Promise<void>;
  /** Handle a down-channel frame (ack / accept / cancel). */
  onFrame(frame: UplinkFrame): Promise<void>;
}

export function createUplinkSender(deps: UplinkSenderDeps): UplinkSender {
  let cursor: AckCursorState = { ackSeq: 0, maxSentWireSeq: 0 };

  const replayFrom = (fromSeq: number) => {
    const rows = deps.outbox.replay({
      runId: deps.runId,
      fenceToken: deps.fenceToken,
      fromSeq,
    });
    for (const frame of outboxRowsToChunkFrames(rows)) {
      deps.send(frame);
      cursor = {
        ...cursor,
        maxSentWireSeq: Math.max(cursor.maxSentWireSeq, frame.wireSeq),
      };
    }
  };

  return {
    async start(): Promise<void> {
      const bearer = await deps.getAccessToken();
      deps.send({
        type: "hello",
        machineId: deps.machineId,
        protocol: PROTOCOL_VERSION,
        bearer,
      });
      // Resume from the contiguous ack floor + 1 (full prefix on a fresh run).
      replayFrom(cursor.ackSeq + 1);
    },

    async onFrame(frame: UplinkFrame): Promise<void> {
      switch (frame.type) {
        case "ack": {
          const { advanced, newState } = processAckFrame(cursor, frame.ackSeq);
          if (advanced) {
            cursor = newState;
            deps.outbox.truncateUpToSeq({
              runId: deps.runId,
              fenceToken: deps.fenceToken,
              ackSeq: frame.ackSeq,
            });
          }
          break;
        }
        case "accept": {
          // The cluster's resume cursor: it has everything up to ackSeq, so
          // resume sending from ackSeq+1. A cancelled accept aborts the run.
          cursor = { ackSeq: frame.ackSeq, maxSentWireSeq: frame.ackSeq };
          if (frame.cancelled) {
            deps.onCancel();
            return;
          }
          replayFrom(frame.ackSeq + 1);
          break;
        }
        case "cancel":
          deps.onCancel();
          break;
        default:
          // chunk/hello/resume/flow are not received by the sender (up-channel
          // or unsupported); ignore.
          break;
      }
    },
  };
}
