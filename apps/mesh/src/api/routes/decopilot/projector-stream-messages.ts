import { DECOPILOT_STREAM_SUBJECT_PREFIX } from "@decocms/harness/run-stream-codec";

export const DECOPILOT_STREAM_NAME = "DECOPILOT_STREAMS";

export interface DoneEnvelope {
  done: true;
  finalSeq: number;
}

export function runIdFromSubject(subject: string): string | null {
  const prefix = `${DECOPILOT_STREAM_SUBJECT_PREFIX}.`;
  if (!subject.startsWith(prefix)) return null;
  const runId = subject.slice(prefix.length);
  return runId.length > 0 ? runId : null;
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
