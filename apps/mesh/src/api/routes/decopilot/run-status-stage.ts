import type { UIMessageChunk } from "ai";
import type { StreamBuffer } from "./stream-buffer";

export const RUN_STATUS_STAGES = [
  "waiting-runner",
  "starting-run",
  "gathering-context",
  "preparing-tools",
  "starting-assistant",
  "analyzing-scope",
] as const;

export type BackendRunStatusStage = (typeof RUN_STATUS_STAGES)[number];

export const PREPARE_RUN_STATUS_STAGES = [
  "gathering-context",
  "preparing-tools",
  "starting-assistant",
  "analyzing-scope",
] as const satisfies readonly BackendRunStatusStage[];

const STAGE_SET = new Set<string>(RUN_STATUS_STAGES);

export function shouldPublishClusterRunStatus(input: {
  harnessId?: string | null;
  sandboxProviderKind?: string | null;
}): boolean {
  return (
    input.sandboxProviderKind === "agent-sandbox" &&
    input.harnessId === "decopilot"
  );
}

export function shouldPublishThreadGateRunStatus(input: {
  harnessId?: string | null;
  sandboxProviderKind?: string | null;
}): boolean {
  // Legacy requests may have no target; those replay through hosted dispatch
  // unless the target is explicitly user-desktop.
  return (
    input.sandboxProviderKind !== "user-desktop" &&
    input.harnessId === "decopilot"
  );
}

export type RunStatusChunk = Extract<
  UIMessageChunk,
  { type: `data-${string}` }
> & {
  type: "data-run-status";
  id: "run-status";
  data: { stage: BackendRunStatusStage };
};

export function buildRunStatusChunk(
  stage: BackendRunStatusStage,
): RunStatusChunk {
  return {
    type: "data-run-status",
    id: "run-status",
    data: { stage },
  } as RunStatusChunk;
}

export function isRunStatusChunk(chunk: unknown): chunk is RunStatusChunk {
  if (!chunk || typeof chunk !== "object") return false;
  const record = chunk as {
    type?: unknown;
    id?: unknown;
    data?: { stage?: unknown };
  };
  return (
    record.type === "data-run-status" &&
    record.id === "run-status" &&
    typeof record.data?.stage === "string" &&
    STAGE_SET.has(record.data.stage)
  );
}

export async function publishRunStatusStage(
  streamBuffer: Pick<StreamBuffer, "publishRawChunk"> | undefined,
  taskId: string,
  stage: BackendRunStatusStage,
): Promise<void> {
  if (!streamBuffer) return;
  try {
    await streamBuffer.publishRawChunk(taskId, buildRunStatusChunk(stage));
  } catch {
    // Best-effort UI status. Never fail dispatch because a status hint failed.
  }
}
