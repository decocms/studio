/**
 * Workflows Plugin - Database Types
 *
 * Kysely table interfaces for all workflow tables.
 */

import type { Generated, Insertable, Selectable, Updateable } from "kysely";

export type ExecutionStatus =
  | "enqueued"
  | "running"
  | "cancelled"
  | "success"
  | "error";

// ============================================================================
// workflow_collection - Reusable workflow templates
// ============================================================================

export interface WorkflowCollectionTable {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  virtual_mcp_id: string;
  /** JSON-serialized Step[] */
  steps: string;
  /** JSON-serialized input schema, or null */
  input_schema: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  created_by: string | null;
  updated_by: string | null;
}

export type WorkflowCollectionRow = Selectable<WorkflowCollectionTable>;
export type NewWorkflowCollection = Insertable<WorkflowCollectionTable>;
export type WorkflowCollectionUpdate = Updateable<WorkflowCollectionTable>;

// ============================================================================
// workflow - Immutable snapshot per execution
// ============================================================================

export interface WorkflowTable {
  id: string;
  workflow_collection_id: string | null;
  organization_id: string;
  /** JSON-serialized Step[] */
  steps: string;
  /** JSON-serialized Record<string, unknown> | null */
  input: string | null;
  virtual_mcp_id: string;
  created_at_epoch_ms: number;
  created_by: string | null;
}

export type WorkflowRow = Selectable<WorkflowTable>;
export type NewWorkflow = Insertable<WorkflowTable>;

// ============================================================================
// workflow_execution - Execution state
// ============================================================================

export interface WorkflowExecutionTable {
  id: string;
  workflow_id: string;
  organization_id: string;
  status: Generated<ExecutionStatus>;
  /** JSON-serialized input */
  input: string | null;
  /** JSON-serialized output */
  output: string | null;
  /** JSON-serialized error */
  error: string | null;
  created_at: number;
  updated_at: number;
  start_at_epoch_ms: number | null;
  started_at_epoch_ms: number | null;
  completed_at_epoch_ms: number | null;
  timeout_ms: number | null;
  deadline_at_epoch_ms: number | null;
  created_by: string | null;
}

export type WorkflowExecutionRow = Selectable<WorkflowExecutionTable>;
export type NewWorkflowExecution = Insertable<WorkflowExecutionTable>;
export type WorkflowExecutionUpdate = Updateable<WorkflowExecutionTable>;

// ============================================================================
// workflow_execution_step_result - Per-step results
// ============================================================================

export interface WorkflowExecutionStepResultTable {
  execution_id: string;
  step_id: string;
  started_at_epoch_ms: number | null;
  completed_at_epoch_ms: number | null;
  /** JSON-serialized output */
  output: string | null;
  /** JSON-serialized error */
  error: string | null;
  /** JSON-serialized raw tool output (before transform code) */
  raw_tool_output: string | null;
  attempt_number: Generated<number>;
}

export type StepResultRow = Selectable<WorkflowExecutionStepResultTable>;
export type NewStepResult = Insertable<WorkflowExecutionStepResultTable>;

// ============================================================================
// Combined database interface
// ============================================================================

export interface WorkflowDatabase {
  workflow_collection: WorkflowCollectionTable;
  workflow: WorkflowTable;
  workflow_execution: WorkflowExecutionTable;
  workflow_execution_step_result: WorkflowExecutionStepResultTable;
}
