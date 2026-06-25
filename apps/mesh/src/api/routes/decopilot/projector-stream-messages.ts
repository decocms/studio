import {
  buildChunkMsgId,
  buildCheckpointMsgId,
  buildDoneMsgId,
  CHECKPOINT_DEBOUNCE_MS,
  DECOPILOT_STREAM_SUBJECT_PREFIX,
  streamSubject,
} from "@decocms/sandbox/dispatch/relay-publisher";

export const DECOPILOT_STREAM_NAME = "DECOPILOT_STREAMS";

// The producer-side wire helpers (subject + msgId builders + checkpoint
// debounce) live in the shared package — the single source of truth, also used
// by the e2e fake-daemon relay. Re-exported here so the projector + ingest code
// keep their one import site.
export {
  buildChunkMsgId,
  buildCheckpointMsgId,
  buildDoneMsgId,
  CHECKPOINT_DEBOUNCE_MS,
  DECOPILOT_STREAM_SUBJECT_PREFIX,
  streamSubject,
};

export type ParsedRunStreamMsgId =
  | {
      kind: "chunk";
      runId: string;
      fenceToken: string;
      seq: number;
      fragmentIndex: number | null;
    }
  | {
      kind: "done";
      runId: string;
      fenceToken: string;
      finalSeq: number;
    }
  | {
      kind: "checkpoint";
      runId: string;
      fenceToken: string;
      headSeq: number;
    };

export interface DoneEnvelope {
  done: true;
  finalSeq: number;
}

function positiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonnegativeInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function runIdFromSubject(subject: string): string | null {
  const prefix = `${DECOPILOT_STREAM_SUBJECT_PREFIX}.`;
  if (!subject.startsWith(prefix)) return null;
  const runId = subject.slice(prefix.length);
  return runId.length > 0 ? runId : null;
}

export function parseRunStreamMsgId(
  msgId: string | undefined,
): ParsedRunStreamMsgId | null {
  if (!msgId) return null;
  const parts = msgId.split(":");
  const [runId, fenceToken, third, fourth, fifth] = parts;
  if (!runId || !fenceToken || !third) return null;
  if (third === "done") {
    const finalSeq = positiveInt(fourth);
    return parts.length === 4 && finalSeq !== null
      ? { kind: "done", runId, fenceToken, finalSeq }
      : null;
  }
  if (third === "ckpt") {
    const headSeq = positiveInt(fourth);
    return parts.length === 4 && headSeq !== null
      ? { kind: "checkpoint", runId, fenceToken, headSeq }
      : null;
  }
  const seq = positiveInt(third);
  if (seq === null) return null;
  if (parts.length === 3) {
    return { kind: "chunk", runId, fenceToken, seq, fragmentIndex: null };
  }
  if (parts.length === 5 && fourth === "frag") {
    const fragmentIndex = nonnegativeInt(fifth);
    return fragmentIndex === null
      ? null
      : { kind: "chunk", runId, fenceToken, seq, fragmentIndex };
  }
  return null;
}

export function isDoneEnvelope(value: unknown): value is DoneEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.done === true &&
    Number.isInteger(record.finalSeq) &&
    (record.finalSeq as number) > 0
  );
}

export interface CheckpointEnvelope {
  checkpoint: true;
  headSeq: number;
}

export function isCheckpointEnvelope(
  value: unknown,
): value is CheckpointEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.checkpoint === true &&
    Number.isInteger(record.headSeq) &&
    (record.headSeq as number) > 0
  );
}
