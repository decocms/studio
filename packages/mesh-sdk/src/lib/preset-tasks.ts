/**
 * Shared preset-task types. Both the mesh backend (storage, registry,
 * routes) and the frontend (usePresetTasks, install dialogs, tile renderer)
 * read these from here so the FE and BE shapes can't drift apart.
 */

export interface PresetTaskDisplay {
  title: string;
  /** Public-asset path under `apps/mesh/public/` (e.g. `/home/task-brand.svg`). */
  thumb: string;
  /** 1/2/3 for the brand → site → monitoring guided flow; null otherwise. */
  step: number | null;
}

export type PresetTaskAction =
  | { kind: "new-chat" }
  | { kind: "import-deco" }
  | { kind: "install-github" }
  | { kind: "install-system-health" }
  | { kind: "preset" };

export type PresetTaskStatus =
  | "started"
  | "running"
  | "completed"
  | "dismissed"
  | "error";

export type PresetTaskStepStatus = "pending" | "running" | "done" | "error";

export interface PresetTaskStep {
  name: string;
  status: PresetTaskStepStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface PresetTaskState {
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
}

export interface VisiblePresetTask {
  id: string;
  display: PresetTaskDisplay;
  action: PresetTaskAction;
  state: PresetTaskState | undefined;
  dismissible: boolean;
}

export interface StartPresetTaskResult {
  taskId: string;
  virtualMcpId: string;
}
