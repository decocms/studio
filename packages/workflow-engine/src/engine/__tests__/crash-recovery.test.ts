import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Kysely } from "kysely";
import type { WorkflowDatabase } from "../../storage/types";
import { WorkflowExecutionStorage } from "../../storage/workflow-execution";
import {
  createTestDb,
  createMockOrchestratorContext,
  makeCodeStep,
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

describe("Crash Recovery (recoverStuckExecutions)", () => {
  describe("basic recovery", () => {
    it("recovers a running execution with no step results", async () => {
      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, {}),
      ]);

      await storage.claimExecution(executionId);
      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("running");

      const recovered = await storage.recoverStuckExecutions();
      expect(recovered).toHaveLength(1);
      expect(recovered[0].id).toBe(executionId);
      expect(recovered[0].organization_id).toBe(TEST_ORG_ID);

      const afterRecovery = await storage.getExecution(
        executionId,
        TEST_ORG_ID,
      );
      expect(afterRecovery!.status).toBe("enqueued");
    });

    it("recovered execution can be re-claimed and completed", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, {}),
        makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" }),
      ]);

      await storage.claimExecution(executionId);

      await storage.recoverStuckExecutions();

      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const finalExecution = await storage.getExecution(
        executionId,
        TEST_ORG_ID,
      );
      expect(finalExecution!.status).toBe("success");
    });

    it("does not affect enqueued or completed executions", async () => {
      const enqueuedId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, {}),
      ]);

      const completedId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, {}),
      ]);
      await storage.claimExecution(completedId);
      await storage.updateExecution(completedId, {
        status: "success",
        completed_at_epoch_ms: Date.now(),
      });

      const recovered = await storage.recoverStuckExecutions();
      expect(recovered).toHaveLength(0);

      const enqueued = await storage.getExecution(enqueuedId, TEST_ORG_ID);
      expect(enqueued!.status).toBe("enqueued");

      const completed = await storage.getExecution(completedId, TEST_ORG_ID);
      expect(completed!.status).toBe("success");
    });
  });

  describe("recovery with partial progress", () => {
    it("preserves completed steps and resolves stale claims (code steps retried)", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("A", IDENTITY_CODE, {}),
        makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" }),
        makeCodeStep("C", IDENTITY_CODE, { fromB: "@B" }),
      ]);

      // Simulate: A completed, B claimed but never started (started_at_epoch_ms is null)
      await storage.claimExecution(executionId);
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "A",
        output: { result: "a" },
        completed_at_epoch_ms: Date.now(),
      });
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "B",
        // No completed_at_epoch_ms — stale claim, started_at_epoch_ms is null
      });

      // Recover (just resets execution to enqueued, leaves step results intact)
      const recovered = await storage.recoverStuckExecutions();
      expect(recovered).toHaveLength(1);

      // Step A should still exist (completed)
      const stepA = await storage.getStepResult(executionId, "A");
      expect(stepA).not.toBeNull();
      expect(stepA!.completed_at_epoch_ms).not.toBeNull();

      // Step B still exists in DB (recovery doesn't delete it anymore)
      // The orchestrator will resolve it when re-claiming
      const stepB = await storage.getStepResult(executionId, "B");
      expect(stepB).not.toBeNull();
      expect(stepB!.started_at_epoch_ms).toBeNull();

      // Re-publish and drain to completion
      // The orchestrator's resolveIncompleteStepResults will delete B (never started)
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const finalExecution = await storage.getExecution(
        executionId,
        TEST_ORG_ID,
      );
      expect(finalExecution!.status).toBe("success");

      // All three steps should be completed
      const stepResults = await storage.getStepResults(executionId);
      const completedSteps = stepResults.filter((r) => r.completed_at_epoch_ms);
      expect(completedSteps).toHaveLength(3);
    });

    it("tool step interrupted during execution is marked as error", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeToolStep("send_email", "SEND_EMAIL", { to: "test@example.com" }),
        makeCodeStep("B", IDENTITY_CODE, { fromA: "@send_email" }),
      ]);

      // Simulate: execution claimed, tool step claimed AND started executing
      await storage.claimExecution(executionId);
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "send_email",
      });
      // Mark as started (simulates the updateStepResult that happens before tool call)
      await storage.updateStepResult(executionId, "send_email", {
        started_at_epoch_ms: Date.now(),
      });

      // Recover
      await storage.recoverStuckExecutions();

      // Re-publish — orchestrator should mark the tool step as error (not retry it)
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const stepResult = await storage.getStepResult(executionId, "send_email");
      expect(stepResult).not.toBeNull();
      expect(stepResult!.completed_at_epoch_ms).not.toBeNull();
      expect(stepResult!.error).toContain("interrupted by process restart");

      // Workflow should fail because the tool step errored
      const finalExecution = await storage.getExecution(
        executionId,
        TEST_ORG_ID,
      );
      expect(finalExecution!.status).toBe("error");
    });

    it("code step interrupted during execution is safely retried", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep(
          "compute",
          "export default function(input) { return { doubled: 42 }; }",
          {},
        ),
      ]);

      // Simulate: execution claimed, code step claimed AND started executing
      await storage.claimExecution(executionId);
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "compute",
      });
      await storage.updateStepResult(executionId, "compute", {
        started_at_epoch_ms: Date.now(),
      });

      // Recover
      await storage.recoverStuckExecutions();

      // Re-publish — orchestrator should delete the code step result and retry
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const stepResult = await storage.getStepResult(executionId, "compute");
      expect(stepResult).not.toBeNull();
      expect(stepResult!.completed_at_epoch_ms).not.toBeNull();
      expect(stepResult!.error).toBeNull();
      expect(stepResult!.output).toEqual({ doubled: 42 });

      const finalExecution = await storage.getExecution(
        executionId,
        TEST_ORG_ID,
      );
      expect(finalExecution!.status).toBe("success");
    });
  });

  describe("forEach crash recovery", () => {
    it("recovers a forEach workflow that crashed mid-iteration", async () => {
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
      ]);

      // Simulate: produce completed, process parent claimed, some iterations in-flight
      await storage.claimExecution(executionId);
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "produce",
        output: [1, 2, 3],
        completed_at_epoch_ms: Date.now(),
      });
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "process",
      });
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "process[0]",
        output: { doubled: 2 },
        completed_at_epoch_ms: Date.now(),
      });
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "process[1]",
        // Stale claim
      });

      // Recover
      const recovered = await storage.recoverStuckExecutions();
      expect(recovered).toHaveLength(1);

      // Completed steps should be preserved
      const produce = await storage.getStepResult(executionId, "produce");
      expect(produce).not.toBeNull();
      expect(produce!.completed_at_epoch_ms).not.toBeNull();

      const iteration0 = await storage.getStepResult(executionId, "process[0]");
      expect(iteration0).not.toBeNull();
      expect(iteration0!.completed_at_epoch_ms).not.toBeNull();

      // Stale claims still exist in DB (recovery doesn't delete them anymore)
      const parentStep = await storage.getStepResult(executionId, "process");
      expect(parentStep).not.toBeNull();
      expect(parentStep!.completed_at_epoch_ms).toBeNull();

      const iteration1 = await storage.getStepResult(executionId, "process[1]");
      expect(iteration1).not.toBeNull();
      expect(iteration1!.completed_at_epoch_ms).toBeNull();

      // Re-publish and drain to completion
      // The orchestrator's resolveIncompleteStepResults will handle the stale claims
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const finalExecution = await storage.getExecution(
        executionId,
        TEST_ORG_ID,
      );
      expect(finalExecution!.status).toBe("success");
    });

    it("recovers a forEach workflow where all iterations completed but parent not finalized", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep("produce", "export default function() { return [1, 2]; }"),
        makeCodeStep(
          "process",
          "export default function(input) { return { doubled: input.value * 2 }; }",
          { value: "@item" },
          { forEach: { ref: "@produce", concurrency: 10 } },
        ),
      ]);

      // Simulate: produce completed, all iterations completed, but parent step not finalized
      await storage.claimExecution(executionId);
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "produce",
        output: [1, 2],
        completed_at_epoch_ms: Date.now(),
      });
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "process",
      });
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "process[0]",
        output: { doubled: 2 },
        completed_at_epoch_ms: Date.now(),
      });
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "process[1]",
        output: { doubled: 4 },
        completed_at_epoch_ms: Date.now(),
      });

      // Recover
      await storage.recoverStuckExecutions();

      // Parent claim still exists (recovery doesn't delete step results)
      const parentStep = await storage.getStepResult(executionId, "process");
      expect(parentStep).not.toBeNull();

      // Re-publish and drain to completion
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const finalExecution = await storage.getExecution(
        executionId,
        TEST_ORG_ID,
      );
      expect(finalExecution!.status).toBe("success");
    });
  });

  describe("multiple stuck executions", () => {
    it("recovers all running executions at once", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const id1 = await startWorkflow([makeCodeStep("A", IDENTITY_CODE, {})]);
      const id2 = await startWorkflow([makeCodeStep("B", IDENTITY_CODE, {})]);

      await storage.claimExecution(id1);
      await storage.claimExecution(id2);

      const recovered = await storage.recoverStuckExecutions();
      expect(recovered).toHaveLength(2);

      const recoveredIds = recovered.map((r) => r.id).sort();
      expect(recoveredIds).toEqual([id1, id2].sort());

      const exec1 = await storage.getExecution(id1, TEST_ORG_ID);
      const exec2 = await storage.getExecution(id2, TEST_ORG_ID);
      expect(exec1!.status).toBe("enqueued");
      expect(exec2!.status).toBe("enqueued");

      await ctx.publish("workflow.execution.created", id1);
      await ctx.publish("workflow.execution.created", id2);
      await ctx.drainEvents();

      const final1 = await storage.getExecution(id1, TEST_ORG_ID);
      const final2 = await storage.getExecution(id2, TEST_ORG_ID);
      expect(final1!.status).toBe("success");
      expect(final2!.status).toBe("success");
    });
  });

  describe("no-op when nothing to recover", () => {
    it("returns empty array when no running executions exist", async () => {
      const recovered = await storage.recoverStuckExecutions();
      expect(recovered).toHaveLength(0);
    });
  });

  describe("recovery with pending retry", () => {
    it("re-dispatches pending retry step instead of deleting it", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const executionId = await startWorkflow([
        makeCodeStep(
          "retryable",
          "export default function(input) { return { ok: true }; }",
          {},
        ),
      ]);

      // Simulate: execution claimed, step has been reset for retry (attempt 2)
      // but the process crashed before the delayed event was delivered
      await storage.claimExecution(executionId);
      await storage.createStepResult({
        execution_id: executionId,
        step_id: "retryable",
      });
      // Reset for retry: clear fields, bump attempt_number, null out started_at
      await storage.resetStepResultForRetry(executionId, "retryable", 2);

      // Verify the step is in the expected pending-retry state
      const beforeRecovery = await storage.getStepResult(
        executionId,
        "retryable",
      );
      expect(beforeRecovery).not.toBeNull();
      expect(beforeRecovery!.attempt_number).toBe(2);
      expect(beforeRecovery!.started_at_epoch_ms).toBeNull();

      // Recover and re-publish
      await storage.recoverStuckExecutions();
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      // The step result should NOT have been deleted (it was re-dispatched, not removed)
      const afterRecovery = await storage.getStepResult(
        executionId,
        "retryable",
      );
      expect(afterRecovery).not.toBeNull();
      expect(afterRecovery!.attempt_number).toBe(2);

      // Recovery publishes the retry with a backoff delay, so it goes to scheduledEvents
      const retryEvent = ctx.scheduledEvents.find(
        (e) =>
          e.type === "workflow.step.execute" &&
          (e.data as Record<string, unknown>)?.stepName === "retryable",
      );
      expect(retryEvent).toBeDefined();
      expect(retryEvent!.options?.deliverAt).toBeDefined();

      // Simulate the scheduled event being delivered (move to immediate queue)
      for (const evt of ctx.scheduledEvents) {
        ctx.capturedEvents.push({ ...evt, options: undefined });
      }
      ctx.scheduledEvents.length = 0;
      await ctx.drainEvents();

      // After the retry executes, the step should complete successfully
      const finalResult = await storage.getStepResult(executionId, "retryable");
      expect(finalResult).not.toBeNull();
      expect(finalResult!.completed_at_epoch_ms).not.toBeNull();
      expect(finalResult!.error).toBeNull();

      const finalExecution = await storage.getExecution(
        executionId,
        TEST_ORG_ID,
      );
      expect(finalExecution!.status).toBe("success");
    });
  });
});
