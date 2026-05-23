/**
 * Workflows Plugin - Server Entry Point
 *
 * Mesh adapter for `@decocms/workflow-engine`. Wires the engine's storage
 * into the mesh plugin lifecycle, routes inbound event-bus events to the
 * engine, and re-publishes recovered executions on startup.
 *
 * Tools (12 MCP tools) live in this package and read engine storage through
 * the singleton `getPluginStorage()`.
 */

import type { Kysely } from "kysely";
import type { ServerPlugin } from "@decocms/bindings/server-plugin";
import {
  WorkflowCollectionStorage,
  WorkflowExecutionStorage,
  migrations as engineMigrations,
  type WorkflowDatabase,
} from "@decocms/workflow-engine";
import { PLUGIN_ID, PLUGIN_DESCRIPTION } from "../shared";
import { tools } from "./tools";
import {
  WORKFLOW_EVENTS,
  handleWorkflowEventsFireAndForget,
} from "./events/handler";
import {
  getPluginStorage,
  setPluginStorage,
  type WorkflowPluginStorage,
} from "./types";

export const serverPlugin: ServerPlugin = {
  id: PLUGIN_ID,
  description: PLUGIN_DESCRIPTION,
  tools,
  migrations: engineMigrations,

  // Build the engine storage facade against the mesh-provided Kysely
  // instance and stash it in the singleton so tools can read it.
  createStorage: (ctx) => {
    const db = ctx.db as Kysely<WorkflowDatabase>;
    const storage: WorkflowPluginStorage = {
      collections: new WorkflowCollectionStorage(db),
      executions: new WorkflowExecutionStorage(db),
    };
    setPluginStorage(storage);
    return storage;
  },

  // The system auto-subscribes the SELF connection to these event types
  // per-org. The mesh delivers each batch with org-scoped publish + proxy
  // already bound, so we route directly through the engine's per-batch
  // OrchestratorContext.
  onEvents: {
    types: [...WORKFLOW_EVENTS],
    handler: (events, ctx) => {
      const storage = getPluginStorage();
      handleWorkflowEventsFireAndForget(events, {
        storage: storage.executions,
        publish: (type, subject, data, options) =>
          ctx.publish(type, subject, data, options),
        createMCPProxy: (connectionId) => ctx.createMCPProxy(connectionId),
      });
    },
  },

  // Recovery: reset `running` executions left by a prior process and
  // re-publish resumed events so a worker picks them up.
  onStartup: async (ctx) => {
    const storage = getPluginStorage();
    const recovered = await storage.executions.recoverStuckExecutions();
    if (recovered.length === 0) return;

    console.log(
      `[Workflows] Recovering ${recovered.length} stuck execution(s) from previous shutdown`,
    );
    for (const execution of recovered) {
      try {
        await ctx.publish(execution.organization_id, {
          type: "workflow.execution.resumed",
          subject: execution.id,
        });
      } catch (error) {
        console.error(
          `[Workflows] Failed to re-publish execution ${execution.id}:`,
          error,
        );
      }
    }
  },
};
