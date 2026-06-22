export const DECOPILOT_STREAM_NAME = "DECOPILOT_STREAMS";
export const DECOPILOT_STREAM_SUBJECT_PREFIX = "decopilot.stream";

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

function assertSafeSubjectToken(id: string): void {
  if (/[.*>\s]/.test(id)) throw new Error("Invalid NATS subject token");
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

export function streamSubject(runId: string): string {
  assertSafeSubjectToken(runId);
  return `${DECOPILOT_STREAM_SUBJECT_PREFIX}.${runId}`;
}

export function runIdFromSubject(subject: string): string | null {
  const prefix = `${DECOPILOT_STREAM_SUBJECT_PREFIX}.`;
  if (!subject.startsWith(prefix)) return null;
  const runId = subject.slice(prefix.length);
  return runId.length > 0 ? runId : null;
}

export function buildChunkMsgId(input: {
  runId: string;
  fenceToken: string;
  seq: number;
  fragmentIndex?: number;
}): string {
  const base = `${input.runId}:${input.fenceToken}:${input.seq}`;
  return input.fragmentIndex === undefined
    ? base
    : `${base}:frag:${input.fragmentIndex}`;
}

export function buildDoneMsgId(input: {
  runId: string;
  fenceToken: string;
  finalSeq: number;
}): string {
  return `${input.runId}:${input.fenceToken}:done:${input.finalSeq}`;
}

export function buildCheckpointMsgId(input: {
  runId: string;
  fenceToken: string;
  headSeq: number;
}): string {
  return `${input.runId}:${input.fenceToken}:ckpt:${input.headSeq}`;
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
