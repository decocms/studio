import type { UIMessageChunk } from "ai";
import type { StreamBuffer } from "./stream-buffer";

const RUN_STATUS_STAGES = [
  "waiting-runner",
  "starting-run",
  // Sandbox-hosted only: the pod is booting and the repo is being checked out.
  // The longest silence in a claude-code run, and the one the generic
  // "Thinking…" fallback described worst.
  "starting-sandbox",
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

/**
 * Whether a run reports its pre-content progress at all. Both hosted harnesses
 * do; they differ only in the channel (see {@link publishRunStatusStage}).
 */
export function shouldPublishRunStatus(
  harnessId: string | null | undefined,
): boolean {
  return harnessId === "decopilot" || harnessId === "claude-code";
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

/** The publish surface a stage needs: one raw chunk on the run's own stream. */
export type RunStatusStreamBuffer = Pick<StreamBuffer, "publishRawChunk">;

/**
 * Report one pre-content stage on the run's chunk stream, where the chat is
 * already listening. Raw (out-of-band) so the stage never becomes a message
 * part — `isRunStatusControlChunk` is what keeps it out of the projector.
 *
 * Best-effort: a status hint must never fail a dispatch.
 */
export async function publishRunStatusStage(args: {
  streamBuffer: RunStatusStreamBuffer | undefined;
  harnessId: string | null | undefined;
  taskId: string;
  stage: BackendRunStatusStage;
}): Promise<void> {
  const { streamBuffer, harnessId, taskId, stage } = args;
  if (!streamBuffer || !shouldPublishRunStatus(harnessId)) return;
  try {
    await streamBuffer.publishRawChunk(taskId, buildRunStatusChunk(stage));
  } catch {
    // Best-effort UI status. Never fail dispatch because a status hint failed.
  }
}
