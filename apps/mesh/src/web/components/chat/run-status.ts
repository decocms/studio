export const RUN_STATUS_STAGE_ORDER = [
  "sending",
  "received",
  "waiting-runner",
  "starting-run",
  "gathering-context",
  "preparing-tools",
  "starting-assistant",
  "analyzing-scope",
  "choosing-next-steps",
] as const;

export type RunStatusStage = (typeof RUN_STATUS_STAGE_ORDER)[number];

export interface RunStatusCopy {
  label: string;
  detail: string;
}

export const RUN_STATUS_COPY: Record<RunStatusStage, RunStatusCopy> = {
  sending: {
    label: "Sending your message",
    detail: "Posting the message to the chat",
  },
  received: {
    label: "Request received",
    detail: "The run was accepted and queued",
  },
  "waiting-runner": {
    label: "Waiting for an available runner",
    detail: "Waiting for the per-chat dispatch slot",
  },
  "starting-run": {
    label: "Starting the run",
    detail: "A worker picked up the queued message",
  },
  "gathering-context": {
    label: "Gathering context",
    detail: "Loading history, memory, files, and agent context",
  },
  "preparing-tools": {
    label: "Preparing tools",
    detail: "Resolving models, permissions, MCP tools, and built-ins",
  },
  "starting-assistant": {
    label: "Starting the assistant",
    detail: "Opening the cluster runtime",
  },
  "analyzing-scope": {
    label: "Analyzing scope",
    detail: "The model loop is running before first output",
  },
  "choosing-next-steps": {
    label: "Choosing next steps",
    detail: "The assistant is planning the next action",
  },
};

const RUN_STATUS_STAGE_RANK = new Map<RunStatusStage, number>(
  RUN_STATUS_STAGE_ORDER.map((stage, index) => [stage, index]),
);

function isRunStatusStage(value: unknown): value is RunStatusStage {
  return (
    typeof value === "string" &&
    RUN_STATUS_STAGE_RANK.has(value as RunStatusStage)
  );
}

export function parseRunStatusStageChunk(
  chunk: unknown,
): RunStatusStage | null {
  if (!chunk || typeof chunk !== "object") return null;
  const record = chunk as {
    type?: unknown;
    data?: { stage?: unknown };
  };
  if (record.type !== "data-run-status") return null;
  const stage = record.data?.stage;
  return isRunStatusStage(stage) ? stage : null;
}

export function isRunStatusControlChunk(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  return (chunk as { type?: unknown }).type === "data-run-status";
}

export function advanceRunStatusStage(
  current: RunStatusStage | null,
  incoming: RunStatusStage,
): RunStatusStage {
  if (current === null) return incoming;
  const currentRank = RUN_STATUS_STAGE_RANK.get(current) ?? -1;
  const incomingRank = RUN_STATUS_STAGE_RANK.get(incoming) ?? -1;
  return incomingRank >= currentRank ? incoming : current;
}
