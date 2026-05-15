/**
 * Preset Task Store
 *
 * Typed wrapper over `KVStorage` for preset task state. Each task is stored
 * under its own key (`preset-tasks:<taskId>`) so concurrent writes to
 * different tasks never touch the same row. Concurrent writes to the same
 * task are last-write-wins — acceptable for dismiss/progress updates.
 */

import type { KVStorage } from "./kv";

const kvKey = (taskId: string) => `preset-tasks:${taskId}`;

export type PresetTaskStatus =
  | "started"
  | "running"
  | "completed"
  | "dismissed"
  | "error";

export type PresetTaskStepStatus = "pending" | "running" | "done" | "error";

export type PresetTaskStep = {
  name: string;
  status: PresetTaskStepStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type PresetTaskState = {
  status: PresetTaskStatus;
  workflowRunId?: string;
  /**
   * DBOS workflow handle for presets whose lifecycle is owned by a DBOS
   * workflow (currently `brand-context`). Tools called from the preset's
   * thread look this up to signal completion back to the workflow.
   */
  dbosWorkflowId?: string;
  startedAt?: string;
  completedAt?: string;
  dismissedAt?: string;
  error?: string;
  steps?: PresetTaskStep[];
};

export class PresetTaskStore {
  constructor(private kv: KVStorage) {}

  async get(
    organizationId: string,
    taskId: string,
  ): Promise<PresetTaskState | undefined> {
    const value = await this.kv.get(organizationId, kvKey(taskId));
    return (value ?? undefined) as PresetTaskState | undefined;
  }

  async set(
    organizationId: string,
    taskId: string,
    state: PresetTaskState,
  ): Promise<void> {
    await this.kv.set(organizationId, kvKey(taskId), state);
  }
}
