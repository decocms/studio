/**
 * Concurrent Tool Steps — Regression test
 *
 * Reproduces a bug where parallel tool steps sharing the same proxy factory
 * would interfere with each other. When one step completed and closed its
 * proxy, it could tear down shared downstream clients, causing other
 * in-flight steps to time out.
 *
 * The fix: executeToolStep no longer calls proxy.close() in a finally block.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Kysely } from "kysely";
import type { WorkflowDatabase } from "../../storage/types";
import { WorkflowExecutionStorage } from "../../storage/workflow-execution";
import {
  createTestDb,
  createMockOrchestratorContext,
  makeToolStep,
  TEST_ORG_ID,
  TEST_VIRTUAL_MCP_ID,
} from "../../__tests__/test-helpers";

let db: Kysely<WorkflowDatabase>;
let pglite: { close(): Promise<void> };
let storage: WorkflowExecutionStorage;

beforeEach(async () => {
  ({ db, pglite } = await createTestDb());
  storage = new WorkflowExecutionStorage(db);
});

afterEach(async () => {
  await db.destroy();
  try {
    await pglite.close();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("PGlite is closed")
    ) {
      throw error;
    }
  }
});

describe("Concurrent tool steps", () => {
  it("all parallel tool steps complete when one finishes before others", async () => {
    let closeCount = 0;
    let closedWhileOthersInFlight = false;

    const activeCalls = new Set<string>();

    const ctx = createMockOrchestratorContext(storage);

    // Override createMCPProxy to track concurrent usage and detect
    // the bug: if close() is called while other calls are still in-flight
    ctx.createMCPProxy = async (_connectionId: string) => {
      return {
        async callTool(params: {
          name: string;
          arguments?: Record<string, unknown>;
        }) {
          const callId = `${params.name}_${Math.random().toString(36).slice(2, 6)}`;
          activeCalls.add(callId);

          // Simulate varying response times — step A is slow, B and C are fast
          const delay = params.arguments?.slow === true ? 50 : 5;
          await new Promise((resolve) => setTimeout(resolve, delay));

          activeCalls.delete(callId);
          return { structuredContent: { result: `mock-${params.name}` } };
        },
        async close() {
          closeCount++;
          if (activeCalls.size > 0) {
            closedWhileOthersInFlight = true;
          }
        },
      };
    };

    const executionId = await storage.createExecution({
      organizationId: TEST_ORG_ID,
      virtualMcpId: TEST_VIRTUAL_MCP_ID,
      steps: [
        makeToolStep("step_slow", "SLOW_TOOL", { slow: true }),
        makeToolStep("step_fast_1", "FAST_TOOL", { slow: false }),
        makeToolStep("step_fast_2", "FAST_TOOL", { slow: false }),
      ],
      input: null,
    });

    await ctx.publish("workflow.execution.created", executionId.id);
    await ctx.drainEvents();

    const execution = await storage.getExecution(executionId.id, TEST_ORG_ID);
    expect(execution!.status).toBe("success");

    const stepResults = await storage.getStepResults(executionId.id);
    expect(stepResults).toHaveLength(3);

    for (const result of stepResults) {
      expect(result.completed_at_epoch_ms).not.toBeNull();
      expect(result.error).toBeNull();
    }

    // The fix: proxy.close() is no longer called, so no proxy should be
    // closed while other calls are still in-flight
    expect(closedWhileOthersInFlight).toBe(false);
    // And close should not be called at all (we removed the finally block)
    expect(closeCount).toBe(0);
  });

  it("three independent tool steps all succeed in parallel", async () => {
    const ctx = createMockOrchestratorContext(storage);

    const executionId = await storage.createExecution({
      organizationId: TEST_ORG_ID,
      virtualMcpId: TEST_VIRTUAL_MCP_ID,
      steps: [
        makeToolStep("A", "API_KEY_LIST", { allTables: false }),
        makeToolStep("B", "API_KEY_LIST", { allTables: false }),
        makeToolStep("C", "API_KEY_LIST", { allTables: false }),
      ],
      input: null,
    });

    await ctx.publish("workflow.execution.created", executionId.id);
    await ctx.drainEvents();

    const execution = await storage.getExecution(executionId.id, TEST_ORG_ID);
    expect(execution!.status).toBe("success");

    const stepResults = await storage.getStepResults(executionId.id);
    expect(stepResults).toHaveLength(3);
    for (const result of stepResults) {
      expect(result.completed_at_epoch_ms).not.toBeNull();
      expect(result.error).toBeNull();
    }

    // All three tool calls should have been made
    expect(ctx.proxyCallLog).toHaveLength(3);
    expect(ctx.proxyCallLog.map((c) => c.toolName)).toEqual([
      "API_KEY_LIST",
      "API_KEY_LIST",
      "API_KEY_LIST",
    ]);
  });
});
