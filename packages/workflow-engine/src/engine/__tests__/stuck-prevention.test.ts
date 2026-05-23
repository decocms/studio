/**
 * Stuck Prevention Tests
 *
 * Tests that verify workflows cannot get permanently stuck in
 * pending/running states.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Kysely } from "kysely";
import type { WorkflowDatabase } from "../../storage/types";
import { WorkflowExecutionStorage } from "../../storage/workflow-execution";
import { handleStepCompleted } from "../../engine/orchestrator";
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
    if (!(error instanceof Error) || !error.message.includes("is closed")) {
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

describe("Stuck Prevention", () => {
  // --------------------------------------------------------------------------
  // Step execute handler throws
  // --------------------------------------------------------------------------

  describe("step execute handler throws", () => {
    it("publishes workflow.step.completed with error so workflow transitions to error", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("badStep", "this is completely invalid code !!!@#$"),
      ]);

      // Start execution
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      // The workflow should have transitioned to error (not stuck in running)
      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("error");
    });
  });

  // --------------------------------------------------------------------------
  // All steps complete -> workflow completes
  // --------------------------------------------------------------------------

  describe("all steps complete but workflow still running", () => {
    it("handleStepCompleted transitions to success when all steps done", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, {}),
        makeCodeStep("B", IDENTITY_CODE, {}),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      // Both A and B should complete, and workflow should be success
      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");

      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults).toHaveLength(2);
      for (const r of stepResults) {
        expect(r.completed_at_epoch_ms).not.toBeNull();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Stale claim recovery
  // --------------------------------------------------------------------------

  describe("step claimed but never completed (stale claim)", () => {
    it("after cancel + resume, stale claims are deleted and workflow re-processes", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, {}),
        makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" }),
      ]);

      // Claim execution
      await storage.claimExecution(executionId);

      // Simulate stale claim: step A was claimed but never completed
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "A",
      });

      // Cancel and resume
      await storage.cancelExecution(executionId, TEST_ORG_ID);
      await storage.resumeExecution(executionId, TEST_ORG_ID);

      // Stale claim should be gone
      const staleResult = await storage.getStepResult(executionId, "A");
      expect(staleResult).toBeNull();

      // Re-run from scratch
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
    });
  });

  // --------------------------------------------------------------------------
  // Concurrent step completion race
  // --------------------------------------------------------------------------

  describe("concurrent step completion race", () => {
    it("two parallel steps completing simultaneously both succeed", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, { value: "a" }),
        makeCodeStep("B", IDENTITY_CODE, { value: "b" }),
        makeCodeStep("C", IDENTITY_CODE, { fromA: "@A", fromB: "@B" }),
      ]);

      // Claim execution
      await storage.claimExecution(executionId);

      // Claim both steps
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "A",
      });
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "B",
      });

      // Simulate both completing "simultaneously":
      // Persist results to DB first (source of truth), then call handleStepCompleted
      await storage.updateStepResult(executionId, "A", {
        output: { value: "a" },
        completed_at_epoch_ms: Date.now(),
      });
      await storage.updateStepResult(executionId, "B", {
        output: { value: "b" },
        completed_at_epoch_ms: Date.now(),
      });
      await handleStepCompleted(ctx, executionId, "A");
      await handleStepCompleted(ctx, executionId, "B");

      // Drain any events produced (step C dispatch + completion)
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");

      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults).toHaveLength(3);
    });
  });

  // --------------------------------------------------------------------------
  // ForEach iteration error with continue
  // --------------------------------------------------------------------------

  describe("forEach iteration error with continue", () => {
    it("failed iterations don't block the parent step from completing", async () => {
      const ctx = createMockOrchestratorContext(storage);

      // One iteration will fail, but forEach should still complete
      const executionId = await startWorkflow([
        makeCodeStep(
          "produce",
          "export default function() { return [1, 0, 3]; }",
        ),
        makeCodeStep(
          "process",
          `export default function(input) {
            if (input.value === 0) throw new Error("cannot process zero");
            return { doubled: input.value * 2 };
          }`,
          { value: "@item" },
          { forEach: { ref: "@produce", concurrency: 10 } },
        ),
      ]);

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      // The workflow should complete (forEach errors use "continue" mode)
      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");

      // Parent step should have collected results
      const processResult = await storage.getStepResult(executionId, "process");
      expect(processResult).not.toBeNull();
      expect(processResult!.completed_at_epoch_ms).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Workflow cancelled mid-execution
  // --------------------------------------------------------------------------

  describe("workflow cancelled mid-execution", () => {
    it("steps completing after cancellation don't restart the workflow", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, {}),
        makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" }),
      ]);

      // Claim execution and step A
      await storage.claimExecution(executionId);
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "A",
      });

      // Cancel the execution while step A is in-flight
      await storage.cancelExecution(executionId, TEST_ORG_ID);

      // Step A "completes" after cancellation — persist to DB, then notify
      await storage.updateStepResult(executionId, "A", {
        output: { result: "done" },
        completed_at_epoch_ms: Date.now(),
      });
      await handleStepCompleted(ctx, executionId, "A");

      // Workflow should still be cancelled (not restarted)
      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("cancelled");

      // Step B should NOT have been dispatched
      const stepB = await storage.getStepResult(executionId, "B");
      expect(stepB).toBeNull();
    });
  });
});
