export const RUN_STATUS_STAGE_ORDER = [
  "sending",
  "received",
  "waiting-runner",
  "starting-run",
  "waiting-capacity",
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
    detail: "Adding your message to the chat",
  },
  received: {
    label: "Message received",
    detail: "Your message is in line to be worked on",
  },
  "waiting-runner": {
    label: "Waiting to start",
    detail: "Finishing up the previous message in this chat",
  },
  "starting-run": {
    label: "Getting started",
    detail: "Setting up to work on your message",
  },
  "waiting-capacity": {
    label: "Waiting for a free runner",
    detail:
      "Other runs are using every slot — this one starts as soon as one frees up",
  },
  "gathering-context": {
    label: "Reading the chat",
    detail: "Looking through the history, files, and notes",
  },
  "preparing-tools": {
    label: "Getting ready",
    detail: "Setting up the tools it can use",
  },
  "starting-assistant": {
    label: "Warming up",
    detail: "Almost ready to reply",
  },
  "analyzing-scope": {
    label: "Thinking",
    detail: "Working out how to respond",
  },
  "choosing-next-steps": {
    label: "Thinking",
    detail: "Deciding what to do next",
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
