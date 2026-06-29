import {
  buildChunkMsgId,
  buildDoneMsgId,
  DECOPILOT_STREAM_SUBJECT_PREFIX,
  streamSubject,
} from "@decocms/sandbox/dispatch/relay-publisher";

export const DECOPILOT_STREAM_NAME = "DECOPILOT_STREAMS";

// The producer-side wire helpers (subject + msgId builders) live in the shared
// codec — the single source of truth, also used by the e2e fake-daemon relay.
// Re-exported here so the projector + ingest code keep their one import site.
export {
  buildChunkMsgId,
  buildDoneMsgId,
  DECOPILOT_STREAM_SUBJECT_PREFIX,
  streamSubject,
};

// parseRunStreamMsgId + ParsedRunStreamMsgId are now owned by the codec.
// Re-exported here so all existing importers compile unchanged.
export {
  parseRunStreamMsgId,
  type ParsedRunStreamMsgId,
} from "@decocms/harness/run-stream-codec";

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
