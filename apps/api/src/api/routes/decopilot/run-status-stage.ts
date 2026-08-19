import type { UIMessageChunk } from "ai";
import type { StreamBuffer } from "./stream-buffer";

const RUN_STATUS_STAGES = [
  "waiting-runner",
  "starting-run",
  // Queued behind the hosted-harness queue's per-pod cap (see queue-names.ts).
  "waiting-capacity",
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
  // alongside explicit agent-sandbox targets.
  return (
    input.harnessId === "decopilot" &&
    (input.sandboxProviderKind == null ||
      input.sandboxProviderKind === "agent-sandbox")
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

export function isRunStatusControlChunk(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  return (chunk as { type?: unknown }).type === "data-run-status";
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
