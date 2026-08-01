import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";

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

const RUN_STATUS_I18N_KEYS: Record<
  RunStatusStage,
  { label: TranslationKey; detail: TranslationKey }
> = {
  sending: {
    label: "chat.runStatus.sendingLabel",
    detail: "chat.runStatus.sendingDetail",
  },
  received: {
    label: "chat.runStatus.receivedLabel",
    detail: "chat.runStatus.receivedDetail",
  },
  "waiting-runner": {
    label: "chat.runStatus.waitingRunnerLabel",
    detail: "chat.runStatus.waitingRunnerDetail",
  },
  "starting-run": {
    label: "chat.runStatus.startingRunLabel",
    detail: "chat.runStatus.startingRunDetail",
  },
  "waiting-capacity": {
    label: "chat.runStatus.waitingCapacityLabel",
    detail: "chat.runStatus.waitingCapacityDetail",
  },
  "gathering-context": {
    label: "chat.runStatus.gatheringContextLabel",
    detail: "chat.runStatus.gatheringContextDetail",
  },
  "preparing-tools": {
    label: "chat.runStatus.preparingToolsLabel",
    detail: "chat.runStatus.preparingToolsDetail",
  },
  "starting-assistant": {
    label: "chat.runStatus.startingAssistantLabel",
    detail: "chat.runStatus.startingAssistantDetail",
  },
  "analyzing-scope": {
    label: "chat.runStatus.analyzingScopeLabel",
    detail: "chat.runStatus.analyzingScopeDetail",
  },
  "choosing-next-steps": {
    label: "chat.runStatus.choosingNextStepsLabel",
    detail: "chat.runStatus.choosingNextStepsDetail",
  },
};

/** User-facing copy for a run-status stage, translated via `t`. */
export function getRunStatusCopy(
  t: TFunction,
  stage: RunStatusStage,
): RunStatusCopy {
  const keys = RUN_STATUS_I18N_KEYS[stage];
  return { label: t(keys.label), detail: t(keys.detail) };
}

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
