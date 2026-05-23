/**
 * @decocms/workflow-engine
 *
 * Pure DAG workflow execution engine. No mesh deps, no auth, no transport —
 * just storage + orchestration + ref resolution + sandbox.
 *
 * Wiring:
 *   const engine = createWorkflowEngine({ db, publish, createMCPProxy });
 *   // when an event arrives:
 *   void engine.routeEvent(event);
 *   // on startup:
 *   const recovered = await engine.recoverStuckExecutions();
 *   for (const e of recovered) {
 *     await publish("workflow.execution.resumed", e.id);
 *   }
 */

import { WorkflowCollectionStorage } from "./storage/workflow-collection";
import { WorkflowExecutionStorage } from "./storage/workflow-execution";
import { routeEvent } from "./engine/router";
import type {
  WorkflowEnginePorts,
  WorkflowEvent,
  WorkflowEventType,
  PublishEventFn,
  CreateMCPProxyFn,
  MCPProxy,
} from "./ports";
import type { OrchestratorContext } from "./engine/orchestrator";

// ---------------------------------------------------------------------------
// Public surface types
// ---------------------------------------------------------------------------

export interface WorkflowEngineStorage {
  collections: WorkflowCollectionStorage;
  executions: WorkflowExecutionStorage;
}

export interface WorkflowEngine {
  /** Storage facade — collections (templates) + executions (runtime state). */
  storage: WorkflowEngineStorage;

  /**
   * Route a single workflow event to the orchestrator. Resolves once the
   * relevant handler has completed. Handler errors are caught internally
   * and converted into step-error / completion events so the execution
   * never stalls — the returned promise itself never rejects.
   *
   * Hosts wanting fire-and-forget semantics (mesh: release the bus lock
   * immediately) should call this without awaiting.
   */
  routeEvent: (event: WorkflowEvent) => Promise<void>;

  /**
   * Find executions left in `running` state from a prior process and reset
   * them to `enqueued`. Returns the list so the host can re-publish a
   * `workflow.execution.resumed` event per execution through whatever
   * transport it uses — the engine does NOT publish recovery events.
   */
  recoverStuckExecutions: () => Promise<
    Array<{ id: string; organization_id: string }>
  >;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkflowEngine(
  ports: WorkflowEnginePorts,
): WorkflowEngine {
  const storage: WorkflowEngineStorage = {
    collections: new WorkflowCollectionStorage(ports.db),
    executions: new WorkflowExecutionStorage(ports.db),
  };

  const orchestratorCtx: OrchestratorContext = {
    storage: storage.executions,
    publish: ports.publish,
    createMCPProxy: ports.createMCPProxy,
  };

  return {
    storage,
    routeEvent: async (event) => {
      await routeEvent(event, orchestratorCtx);
    },
    recoverStuckExecutions: () =>
      storage.executions.recoverStuckExecutions(),
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  WORKFLOW_EVENT_TYPES,
  handleWorkflowEvents,
  routeEvent,
} from "./engine/router";

export { WorkflowCollectionStorage } from "./storage/workflow-collection";
export { WorkflowExecutionStorage } from "./storage/workflow-execution";
export { parseJson } from "./storage/json";

export type { OrchestratorContext } from "./engine/orchestrator";

export type {
  WorkflowEnginePorts,
  WorkflowEvent,
  WorkflowEventType,
  PublishEventFn,
  CreateMCPProxyFn,
  MCPProxy,
};

export type {
  WorkflowDatabase,
  ExecutionStatus,
  WorkflowCollectionTable,
  WorkflowTable,
  WorkflowExecutionTable,
  WorkflowExecutionStepResultTable,
  WorkflowCollectionRow,
  WorkflowRow,
  WorkflowExecutionRow,
  StepResultRow,
  NewWorkflowCollection,
  NewWorkflow,
  NewWorkflowExecution,
  NewStepResult,
  WorkflowCollectionUpdate,
  WorkflowExecutionUpdate,
} from "./storage/types";

export type {
  ParsedWorkflow,
  ParsedStepResult,
  ContextStepResult,
  ExecutionContext,
} from "./storage/workflow-execution";

export type { ParsedWorkflowCollection } from "./storage/workflow-collection";

export { migrations, type EngineMigration } from "./storage/migrations";
