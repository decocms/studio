import {
  buildChunkMsgId,
  buildDoneMsgId,
  DECOPILOT_STREAM_SUBJECT_PREFIX,
  streamSubject,
} from "@decocms/sandbox/dispatch/relay-publisher";

export const DECOPILOT_STREAM_NAME = "DECOPILOT_STREAMS";

// The producer-side wire helpers (subject + msgId builders) live in the shared
// package — the single source of truth, also used by the e2e fake-daemon relay.
// Re-exported here so the projector + ingest code keep their one import site.
export {
  buildChunkMsgId,
  buildDoneMsgId,
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
    // Leftover checkpoint markers from in-flight runs must parse to null so
    // they are not misclassified. Checkpoint publication was removed; this
    // branch exists solely as a transition-safety guard.
    return null;
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
