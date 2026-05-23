/**
 * Orchestrator Tests -- Core orchestration + durability
 *
 * Uses in-memory PGlite and mock event bus to test the full
 * orchestration lifecycle with event replay via drainEvents().
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Kysely } from "kysely";
import type { WorkflowDatabase } from "../../storage/types";
import { WorkflowExecutionStorage } from "../../storage/workflow-execution";
import {
  createTestDb,
  createMockOrchestratorContext,
  makeCodeStep,
  TEST_ORG_ID,
  TEST_VIRTUAL_MCP_ID,
} from "../../__tests__/test-helpers";

// ============================================================================
// Setup
// ============================================================================

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

// ============================================================================
// Helpers
// ============================================================================

const IDENTITY_CODE = "export default function(input) { return input; }";

async function startWorkflow(
  steps: Parameters<WorkflowExecutionStorage["createExecution"]>[0]["steps"],
  input?: Record<string, unknown>,
) {
  const { id } = await storage.createExecution({
    organizationId: TEST_ORG_ID,
    virtualMcpId: TEST_VIRTUAL_MCP_ID,
    steps,
    input: input ?? null,
  });
  return id;
}

// ============================================================================
// Tests
// ============================================================================

describe("Orchestrator", () => {
  // --------------------------------------------------------------------------
  // Linear workflow
  // --------------------------------------------------------------------------

  describe("linear workflow (A -> B -> C)", () => {
    it("executes steps in order and completes with success", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, {}),
        makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" }),
        makeCodeStep("C", IDENTITY_CODE, { fromB: "@B" }),
      ]);

      // Publish initial event
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      // Verify execution completed successfully
      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      expect(execution!.completed_at_epoch_ms).not.toBeNull();

      // Verify all steps completed
      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults).toHaveLength(3);
      for (const result of stepResults) {
        expect(result.completed_at_epoch_ms).not.toBeNull();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Parallel workflow
  // --------------------------------------------------------------------------

  describe("parallel workflow (A, B -> C)", () => {
    it("dispatches A and B concurrently, C waits for both", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, { value: "a" }),
        makeCodeStep("B", IDENTITY_CODE, { value: "b" }),
        makeCodeStep("C", IDENTITY_CODE, { fromA: "@A", fromB: "@B" }),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");

      // All 3 steps should have completed
      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults).toHaveLength(3);

      // C should have received outputs from A and B
      const stepC = stepResults.find((r) => r.step_id === "C");
      expect(stepC).not.toBeNull();
      expect(stepC!.completed_at_epoch_ms).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Empty workflow
  // --------------------------------------------------------------------------

  describe("empty workflow", () => {
    it("immediately errors with 'no steps'", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("error");
    });
  });

  // --------------------------------------------------------------------------
  // Cyclic dependency
  // --------------------------------------------------------------------------

  describe("cyclic dependency", () => {
    it("errors with cycle detection message", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, { fromC: "@C" }),
        makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" }),
        makeCodeStep("C", IDENTITY_CODE, { fromB: "@B" }),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("error");
    });
  });

  // --------------------------------------------------------------------------
  // Step error fails workflow
  // --------------------------------------------------------------------------

  describe("step error fails workflow", () => {
    it("sets execution to error status when a step fails", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep(
          "failStep",
          "export default function() { throw new Error('boom'); }",
        ),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("error");
    });
  });

  // --------------------------------------------------------------------------
  // ForEach step
  // --------------------------------------------------------------------------

  describe("forEach step", () => {
    it("dispatches iterations, collects results, continues to next steps", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep(
          "produce",
          "export default function() { return [1, 2, 3]; }",
        ),
        makeCodeStep(
          "process",
          "export default function(input) { return { doubled: input.value * 2 }; }",
          { value: "@item" },
          { forEach: { ref: "@produce", concurrency: 10 } },
        ),
        makeCodeStep("collect", IDENTITY_CODE, { results: "@process" }),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");

      // The process step should have a collected result
      const processResult = await storage.getStepResult(executionId, "process");
      expect(processResult).not.toBeNull();
      expect(processResult!.completed_at_epoch_ms).not.toBeNull();
      expect(Array.isArray(processResult!.output)).toBe(true);
    });

    it("handles forEach with concurrency limit", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep(
          "produce",
          "export default function() { return [1, 2, 3, 4, 5]; }",
        ),
        makeCodeStep(
          "process",
          "export default function(input) { return input; }",
          { value: "@item" },
          { forEach: { ref: "@produce", concurrency: 2 } },
        ),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");

      // All 5 iterations should have completed
      const iterationResults = await storage.getStepResultsByPrefix(
        executionId,
        "process[",
      );
      expect(iterationResults).toHaveLength(5);
      for (const r of iterationResults) {
        expect(r.completed_at_epoch_ms).not.toBeNull();
      }
    });

    it("handles forEach with empty array", async () => {
      const ctx = createMockOrchestratorContext(storage);

      // Use a single forEach step (no downstream dependencies) so we can
      // verify the parent step is completed immediately with [].
      // Note: dispatchStep writes the step result directly for empty arrays
      // without publishing a workflow.step.completed event, so downstream
      // steps won't be triggered automatically in this edge case.
      const executionId = await startWorkflow([
        makeCodeStep("produce", "export default function() { return []; }"),
        makeCodeStep(
          "process",
          "export default function(input) { return input; }",
          { value: "@item" },
          { forEach: { ref: "@produce", concurrency: 10 } },
        ),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      // Parent step should complete immediately with []
      const processResult = await storage.getStepResult(executionId, "process");
      expect(processResult).not.toBeNull();
      expect(processResult!.output).toEqual([]);
      expect(processResult!.completed_at_epoch_ms).not.toBeNull();
    });

    it("output array preserves positional correspondence with input array", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep(
          "produce",
          "export default function() { return [10, 20, 30]; }",
        ),
        makeCodeStep(
          "process",
          "export default function(input) { return { doubled: input.value * 2 }; }",
          { value: "@item" },
          { forEach: { ref: "@produce", concurrency: 10 } },
        ),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const processResult = await storage.getStepResult(executionId, "process");
      const output = processResult!.output as { doubled: number }[];
      // output[0] must correspond to input[0]=10, output[1] to input[1]=20, etc.
      expect(output).toEqual([
        { doubled: 20 },
        { doubled: 40 },
        { doubled: 60 },
      ]);
    });

    it("failed iterations produce null at their index position", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep(
          "produce",
          "export default function() { return [1, 0, 3, 0, 5]; }",
        ),
        makeCodeStep(
          "process",
          `export default function(input) {
            if (input.value === 0) throw new Error("zero!");
            return { ok: input.value };
          }`,
          { value: "@item" },
          { forEach: { ref: "@produce", concurrency: 10 } },
        ),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const processResult = await storage.getStepResult(executionId, "process");
      const output = processResult!.output as ({ ok: number } | null)[];
      // Indices 1 and 3 failed, so they should be null
      expect(output).toEqual([{ ok: 1 }, null, { ok: 3 }, null, { ok: 5 }]);
    });

    it("output order is correct for 12+ items (lexicographic sort would break)", async () => {
      const ctx = createMockOrchestratorContext(storage);

      // 12 items — string sort would give [0],[1],[10],[11],[2],[3],...
      const executionId = await startWorkflow([
        makeCodeStep(
          "produce",
          "export default function() { return [0,1,2,3,4,5,6,7,8,9,10,11]; }",
        ),
        makeCodeStep(
          "process",
          "export default function(input) { return input.value; }",
          { value: "@item" },
          { forEach: { ref: "@produce", concurrency: 4 } },
        ),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const processResult = await storage.getStepResult(executionId, "process");
      const output = processResult!.output as number[];
      expect(output).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });

    it("refills concurrency window when multiple iterations complete simultaneously", async () => {
      const ctx = createMockOrchestratorContext(storage);

      // 10 items with concurrency=3 -- should refill slots properly
      const executionId = await startWorkflow([
        makeCodeStep(
          "produce",
          "export default function() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; }",
        ),
        makeCodeStep(
          "process",
          "export default function(input) { return { value: input.value }; }",
          { value: "@item" },
          { forEach: { ref: "@produce", concurrency: 3 } },
        ),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");

      // All 10 iterations should have completed
      const iterationResults = await storage.getStepResultsByPrefix(
        executionId,
        "process[",
      );
      expect(iterationResults).toHaveLength(10);
      for (const r of iterationResults) {
        expect(r.completed_at_epoch_ms).not.toBeNull();
      }

      // Parent step should have collected all results
      const processResult = await storage.getStepResult(executionId, "process");
      expect(processResult).not.toBeNull();
      expect(processResult!.completed_at_epoch_ms).not.toBeNull();
      expect(Array.isArray(processResult!.output)).toBe(true);
      expect((processResult!.output as unknown[]).length).toBe(10);
    });
  });

  // --------------------------------------------------------------------------
  // Workflow deadline
  // --------------------------------------------------------------------------

  describe("workflow deadline", () => {
    it("fails execution at claim time if deadline already passed", async () => {
      const ctx = createMockOrchestratorContext(storage);

      // Create an execution with a deadline in the past
      const { id: executionId } = await storage.createExecution({
        organizationId: TEST_ORG_ID,
        virtualMcpId: TEST_VIRTUAL_MCP_ID,
        steps: [makeCodeStep("step1", IDENTITY_CODE)],
        timeoutMs: 1, // 1ms timeout — will be expired by the time we process
      });

      // Small delay to ensure deadline passes
      await new Promise((r) => setTimeout(r, 10));

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("error");
      expect(JSON.parse(execution!.error as string)).toContain("deadline");
    });

    it("completes normally when deadline is not exceeded", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("step1", IDENTITY_CODE),
      ]);

      // Run workflow to completion (no timeout set, so no deadline)
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
    });

    it("no scheduled events are produced", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const { id: executionId } = await storage.createExecution({
        organizationId: TEST_ORG_ID,
        virtualMcpId: TEST_VIRTUAL_MCP_ID,
        steps: [makeCodeStep("step1", IDENTITY_CODE)],
        timeoutMs: 60_000,
      });

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      // Deadline is checked synchronously — no scheduled events needed
      expect(ctx.scheduledEvents).toHaveLength(0);
    });
  });
});
