/**
 * Workflow engine ports.
 *
 * Three things the engine demands from its host:
 *   1. A Kysely instance bound to WorkflowDatabase (storage).
 *   2. A publish() function that delivers WorkflowEvents back to the engine
 *      via routeEvent, with deliverAt honored for scheduled events.
 *   3. A createMCPProxy() factory that yields a tool-call client for a given
 *      connectionId — typically the workflow's virtual_mcp_id.
 *
 * The engine knows nothing about orgs, auth, audit, tracing, or transport.
 * Hosts (mesh plugin, runtime embed) wrap the engine with those concerns.
 */

import type { Kysely } from "kysely";
import type { WorkflowDatabase } from "./storage/types";

// ---------------------------------------------------------------------------
// Event model
// ---------------------------------------------------------------------------

export type WorkflowEventType =
  | "workflow.execution.created"
  | "workflow.execution.resumed"
  | "workflow.step.execute"
  | "workflow.step.completed";

/**
 * Event shape consumed by the engine router.
 *
 * `subject` is always an execution ID. `data` carries step-level routing
 * info for step.execute / step.completed: { stepName, iterationIndex? }.
 * `id` is the host's own event ID, kept for log correlation only — the
 * engine never persists it.
 */
export interface WorkflowEvent {
  id: string;
  type: string;
  subject?: string;
  data?: unknown;
}

/**
 * Engine → host hand-back. The host is responsible for getting the event
 * back to routeEvent — synchronously (in-process bus), via a durable queue
 * (mesh event bus), or after the deliverAt timestamp.
 *
 * `deliverAt` is an ISO-8601 string for parity with the mesh event bus
 * contract.
 */
export type PublishEventFn = (
  type: WorkflowEventType,
  subject: string,
  data?: Record<string, unknown>,
  options?: { deliverAt?: string },
) => Promise<void>;

// ---------------------------------------------------------------------------
// Tool transport
// ---------------------------------------------------------------------------

/**
 * Minimal MCP proxy surface — the subset of @modelcontextprotocol/sdk Client
 * that tool-step.ts actually calls.
 */
export interface MCPProxy {
  callTool: (
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ) => Promise<{
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  close: () => Promise<void>;
}

export type CreateMCPProxyFn = (connectionId: string) => Promise<MCPProxy>;

// ---------------------------------------------------------------------------
// Engine ports
// ---------------------------------------------------------------------------

export interface WorkflowEnginePorts {
  db: Kysely<WorkflowDatabase>;
  publish: PublishEventFn;
  createMCPProxy: CreateMCPProxyFn;
}
