import { Kysely } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { KyselyPGlite } from "kysely-pglite";
import type { WorkflowDatabase } from "../../server/storage/types";
import { WorkflowExecutionStorage } from "../../server/storage/workflow-execution";
import { migrations } from "../../server/migrations";
import { migration as migration001 } from "../../server/migrations/001-workflows";
import { handleWorkflowEvents } from "../../server/events/handler";
import type { OrchestratorContext } from "../../server/engine/orchestrator";
import type { Step } from "@decocms/bindings/workflow";

export async function createTestDb(): Promise<{
  db: Kysely<WorkflowDatabase>;
  pglite: PGlite;
}> {
  const pglite = new PGlite();
  await pglite.waitReady;
  const db = new Kysely<WorkflowDatabase>({
    dialect: new KyselyPGlite(pglite).dialect,
  });

  // Create stub tables for FK constraints
  await db.schema
    .createTable("organization")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text")
    .execute();

  // Insert a test organization
  await db
    .insertInto("organization" as never)
    .values({ id: "org_test", name: "Test Org" } as never)
    .onConflict((oc) => oc.column("id" as never).doNothing())
    .execute();

  // Run workflow migrations (skip PG-only ones and heartbeat add/drop pair)
  await migration001.up(db as Kysely<unknown>);
  for (const m of migrations) {
    if (m.name === "001-workflows") continue;
    if (m.name === "002-fix-bigint-timestamps") continue;
    // Skip heartbeat migrations — 003 adds the column, 004 drops it.
    // For fresh PGlite test DBs, the column never needs to exist.
    if (m.name === "003-heartbeat") continue;
    if (m.name === "004-drop-heartbeat") continue;
    await m.up(db as Kysely<unknown>);
  }

  return { db, pglite };
}

interface CapturedEvent {
  type: string;
  subject: string;
  data?: Record<string, unknown>;
  options?: { deliverAt?: string };
}

export interface MockOrchestratorContext extends OrchestratorContext {
  /** All events published so far (pending processing) */
  capturedEvents: CapturedEvent[];
  /** Scheduled events (with deliverAt) collected during drainEvents */
  scheduledEvents: CapturedEvent[];
  /**
   * Drain all captured events through handleWorkflowEvents.
   * Repeats until no new events are produced (simulates the event bus loop).
   * Scheduled events (with deliverAt) are collected in scheduledEvents.
   */
  drainEvents: () => Promise<void>;
  /** Mock createMCPProxy call log */
  proxyCallLog: Array<{
    connectionId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  /** Configure mock proxy responses */
  setProxyResponse: (
    toolName: string,
    response: {
      content?: unknown;
      structuredContent?: unknown;
      isError?: boolean;
    },
  ) => void;
}

/**
 * Create a mock OrchestratorContext with event capture and replay.
 */
export function createMockOrchestratorContext(
  storage: WorkflowExecutionStorage,
): MockOrchestratorContext {
  const capturedEvents: CapturedEvent[] = [];
  const scheduledEvents: CapturedEvent[] = [];
  const proxyCallLog: MockOrchestratorContext["proxyCallLog"] = [];
  const proxyResponses = new Map<
    string,
    { content?: unknown; structuredContent?: unknown; isError?: boolean }
  >();
  let eventIdCounter = 0;

  const ctx: MockOrchestratorContext = {
    storage,
    capturedEvents,
    scheduledEvents,
    proxyCallLog,

    async publish(
      type: string,
      subject: string,
      data?: Record<string, unknown>,
      options?: { deliverAt?: string },
    ): Promise<void> {
      capturedEvents.push({ type, subject, data, options });
    },

    async createMCPProxy(connectionId: string) {
      return {
        async callTool(params: {
          name: string;
          arguments?: Record<string, unknown>;
        }) {
          proxyCallLog.push({
            connectionId,
            toolName: params.name,
            args: params.arguments ?? {},
          });
          const response = proxyResponses.get(params.name);
          if (response) return response;
          return { structuredContent: { result: `mock-${params.name}` } };
        },
        async close() {},
      };
    },

    setProxyResponse(toolName, response) {
      proxyResponses.set(toolName, response);
    },

    async drainEvents(): Promise<void> {
      // Process events in a loop until no new events are produced.
      // Since handleWorkflowEvents is awaited, all handlers have settled
      // by the time it returns, so we just loop until the queue is empty.
      let maxIterations = 200; // Safety limit

      while (maxIterations-- > 0 && capturedEvents.length > 0) {
        // Take all current events, separating immediate from scheduled
        const batch = capturedEvents.splice(0, capturedEvents.length);
        const immediateBatch = batch.filter((e) => !e.options?.deliverAt);
        const scheduledBatch = batch.filter((e) => !!e.options?.deliverAt);
        scheduledEvents.push(...scheduledBatch);

        if (immediateBatch.length === 0) continue;

        // Convert to the format handleWorkflowEvents expects
        const workflowEvents = immediateBatch.map((e) => ({
          type: e.type,
          subject: e.subject,
          data: e.data as unknown,
          id: `evt_${++eventIdCounter}`,
        }));

        // Process them -- awaiting ensures all handlers settle before we loop
        await handleWorkflowEvents(workflowEvents, ctx);
      }
    },
  };

  return ctx;
}

export function makeCodeStep(
  name: string,
  code: string,
  input?: Record<string, unknown>,
  options?: { forEach?: Step["forEach"] },
): Step {
  return {
    name,
    action: { code },
    input: input ?? {},
    ...(options?.forEach ? { forEach: options.forEach } : {}),
  } as Step;
}

export function makeToolStep(
  name: string,
  toolName: string,
  input?: Record<string, unknown>,
  options?: {
    connectionId?: string;
    forEach?: Step["forEach"];
    transformCode?: string;
  },
): Step {
  return {
    name,
    action: {
      connectionId: options?.connectionId ?? "conn_test",
      toolName,
      ...(options?.transformCode
        ? { transformCode: options.transformCode }
        : {}),
    },
    input: input ?? {},
    ...(options?.forEach ? { forEach: options.forEach } : {}),
  } as Step;
}

export const TEST_ORG_ID = "org_test";
export const TEST_VIRTUAL_MCP_ID = "vmcp_test";
