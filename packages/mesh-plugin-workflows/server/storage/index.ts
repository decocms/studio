/**
 * Workflows Plugin - Storage Index
 *
 * Exports all storage components and the factory function.
 */

import type { Kysely } from "kysely";
import type { ServerPluginContext } from "@decocms/bindings/server-plugin";
import { WorkflowCollectionStorage } from "./workflow-collection";
import { WorkflowExecutionStorage } from "./workflow-execution";
import type { WorkflowDatabase } from "./types";

export * from "./types";
export { type ParsedWorkflowCollection } from "./workflow-collection";
export {
  type ParsedWorkflow,
  type ParsedStepResult,
  type ContextStepResult,
  type ExecutionContext,
} from "./workflow-execution";

/**
 * Combined storage interface for the plugin
 */
export interface WorkflowPluginStorage {
  collections: WorkflowCollectionStorage;
  executions: WorkflowExecutionStorage;
}

/**
 * Create the storage instance for the plugin.
 */
export function createStorage(ctx: ServerPluginContext): WorkflowPluginStorage {
  const db = ctx.db as Kysely<WorkflowDatabase>;

  return {
    collections: new WorkflowCollectionStorage(db),
    executions: new WorkflowExecutionStorage(db),
  };
}
