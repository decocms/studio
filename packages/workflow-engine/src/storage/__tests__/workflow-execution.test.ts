/**
 * Workflow Execution Storage Tests
 *
 * Tests for WorkflowExecutionStorage against in-memory PGlite.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Kysely } from "kysely";
import type { WorkflowDatabase } from "../../storage/types";
import { WorkflowExecutionStorage } from "../../storage/workflow-execution";
import {
  createTestDb,
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
// Helper
// ============================================================================

async function createTestExecution(
  overrides?: Partial<
    Parameters<WorkflowExecutionStorage["createExecution"]>[0]
  >,
) {
  return storage.createExecution({
    organizationId: TEST_ORG_ID,
    virtualMcpId: TEST_VIRTUAL_MCP_ID,
    steps: [
      {
        name: "step1",
        action: { code: "export default function(input) { return input; }" },
        input: {},
      },
    ],
    ...overrides,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("WorkflowExecutionStorage", () => {
  // --------------------------------------------------------------------------
  // createExecution
  // --------------------------------------------------------------------------

  describe("createExecution", () => {
    it("creates workflow snapshot + execution with enqueued status", async () => {
      const { id } = await createTestExecution({
        input: { key: "value" },
      });

      expect(id).toBeDefined();

      const execution = await storage.getExecution(id, TEST_ORG_ID);
      expect(execution).not.toBeNull();
      expect(execution!.status).toBe("enqueued");
      expect(execution!.workflow_id).toBeDefined();

      // Verify workflow snapshot was created
      const workflow = await storage.getWorkflow(execution!.workflow_id);
      expect(workflow).not.toBeNull();
      expect(workflow!.organization_id).toBe(TEST_ORG_ID);
      expect(workflow!.steps).toHaveLength(1);
      expect(workflow!.steps[0].name).toBe("step1");
    });

    it("stores input as JSON", async () => {
      const { id } = await createTestExecution({
        input: { userId: "u123", count: 5 },
      });

      const execution = await storage.getExecution(id, TEST_ORG_ID);
      expect(execution).not.toBeNull();

      const workflow = await storage.getWorkflow(execution!.workflow_id);
      expect(workflow!.input).toEqual({ userId: "u123", count: 5 });
    });

    it("handles null input", async () => {
      const { id } = await createTestExecution({ input: null });

      const execution = await storage.getExecution(id, TEST_ORG_ID);
      const workflow = await storage.getWorkflow(execution!.workflow_id);
      expect(workflow!.input).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // claimExecution
  // --------------------------------------------------------------------------

  describe("claimExecution", () => {
    it("atomically transitions enqueued -> running", async () => {
      const { id } = await createTestExecution();

      const claimed = await storage.claimExecution(id);
      expect(claimed).not.toBeNull();
      expect(claimed!.workflow.steps).toHaveLength(1);

      const execution = await storage.getExecution(id, TEST_ORG_ID);
      expect(execution!.status).toBe("running");
    });

    it("returns null if already claimed", async () => {
      const { id } = await createTestExecution();

      // First claim succeeds
      const first = await storage.claimExecution(id);
      expect(first).not.toBeNull();

      // Second claim returns null
      const second = await storage.claimExecution(id);
      expect(second).toBeNull();
    });

    it("returns null for non-existent execution", async () => {
      const result = await storage.claimExecution("non_existent_id");
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // updateExecution
  // --------------------------------------------------------------------------

  describe("updateExecution", () => {
    it("updates execution status", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      const updated = await storage.updateExecution(id, {
        status: "success",
        output: { result: "done" },
        completed_at_epoch_ms: Date.now(),
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("success");
    });

    it("respects onlyIfStatus guard", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      // Should succeed: status is "running"
      const updated = await storage.updateExecution(
        id,
        { status: "success" },
        { onlyIfStatus: "running" },
      );
      expect(updated).not.toBeNull();

      // Should fail: status is now "success", not "running"
      const failed = await storage.updateExecution(
        id,
        { status: "error" },
        { onlyIfStatus: "running" },
      );
      expect(failed).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // cancelExecution
  // --------------------------------------------------------------------------

  describe("cancelExecution", () => {
    it("cancels enqueued execution", async () => {
      const { id } = await createTestExecution();

      const cancelled = await storage.cancelExecution(id, TEST_ORG_ID);
      expect(cancelled).toBe(true);

      const execution = await storage.getExecution(id, TEST_ORG_ID);
      expect(execution!.status).toBe("cancelled");
    });

    it("cancels running execution", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      const cancelled = await storage.cancelExecution(id, TEST_ORG_ID);
      expect(cancelled).toBe(true);

      const execution = await storage.getExecution(id, TEST_ORG_ID);
      expect(execution!.status).toBe("cancelled");
    });

    it("fails for success status", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);
      await storage.updateExecution(id, {
        status: "success",
        completed_at_epoch_ms: Date.now(),
      });

      const cancelled = await storage.cancelExecution(id, TEST_ORG_ID);
      expect(cancelled).toBe(false);
    });

    it("fails for error status", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);
      await storage.updateExecution(id, {
        status: "error",
        error: "something failed",
        completed_at_epoch_ms: Date.now(),
      });

      const cancelled = await storage.cancelExecution(id, TEST_ORG_ID);
      expect(cancelled).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // resumeExecution
  // --------------------------------------------------------------------------

  describe("resumeExecution", () => {
    it("clears incomplete step results and transitions cancelled -> enqueued", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      // Create a completed step result
      await storage.createStepResult({
        execution_id: id,
        step_id: "completedStep",
        output: { done: true },
        completed_at_epoch_ms: Date.now(),
      });

      // Create an incomplete (claimed but not completed) step result
      await storage.createStepResult({
        execution_id: id,
        step_id: "incompleteStep",
      });

      // Cancel then resume
      await storage.cancelExecution(id, TEST_ORG_ID);
      const resumed = await storage.resumeExecution(id, TEST_ORG_ID);
      expect(resumed).toBe(true);

      const execution = await storage.getExecution(id, TEST_ORG_ID);
      expect(execution!.status).toBe("enqueued");

      // Completed step should still exist
      const completedResult = await storage.getStepResult(id, "completedStep");
      expect(completedResult).not.toBeNull();
      expect(completedResult!.completed_at_epoch_ms).not.toBeNull();

      // Incomplete step should be deleted
      const incompleteResult = await storage.getStepResult(
        id,
        "incompleteStep",
      );
      expect(incompleteResult).toBeNull();
    });

    it("fails for non-cancelled execution", async () => {
      const { id } = await createTestExecution();
      // Status is "enqueued", not "cancelled"
      const resumed = await storage.resumeExecution(id, TEST_ORG_ID);
      expect(resumed).toBe(false);
    });

    it("resumes successful execution with failed forEach iterations", async () => {
      const { id } = await createTestExecution({
        steps: [
          {
            name: "upload",
            action: { toolName: "UPLOAD" },
            input: {},
            forEach: { ref: "@input.items" },
          },
        ],
        input: { items: ["a", "b", "c"] },
      });
      await storage.claimExecution(id);

      // Simulate: iterations 0 and 1 succeeded, iteration 2 failed (rate limited)
      await storage.createStepResult({
        execution_id: id,
        step_id: "upload[0]",
        output: { ok: true },
        completed_at_epoch_ms: Date.now(),
      });
      await storage.createStepResult({
        execution_id: id,
        step_id: "upload[1]",
        output: { ok: true },
        completed_at_epoch_ms: Date.now(),
      });
      await storage.createStepResult({
        execution_id: id,
        step_id: "upload[2]",
        error: "Rate limited (429)",
        completed_at_epoch_ms: Date.now(),
      });
      // Parent step finalized with nulls for failed iterations
      await storage.createStepResult({
        execution_id: id,
        step_id: "upload",
        output: [{ ok: true }, { ok: true }, null],
        completed_at_epoch_ms: Date.now(),
      });

      // Mark execution as success (onError: continue)
      await storage.updateExecution(id, {
        status: "success",
        output: [{ ok: true }, { ok: true }, null],
        completed_at_epoch_ms: Date.now(),
      });

      const resumed = await storage.resumeExecution(id, TEST_ORG_ID);
      expect(resumed).toBe(true);

      const execution = await storage.getExecution(id, TEST_ORG_ID);
      expect(execution!.status).toBe("enqueued");

      // Successful iterations preserved
      expect(await storage.getStepResult(id, "upload[0]")).not.toBeNull();
      expect(await storage.getStepResult(id, "upload[1]")).not.toBeNull();

      // Failed iteration deleted (will be re-dispatched)
      expect(await storage.getStepResult(id, "upload[2]")).toBeNull();

      // Parent result deleted (will be re-finalized after retries)
      expect(await storage.getStepResult(id, "upload")).toBeNull();
    });

    it("rejects resume on success execution with no failed steps", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
        output: { done: true },
        completed_at_epoch_ms: Date.now(),
      });

      await storage.updateExecution(id, {
        status: "success",
        completed_at_epoch_ms: Date.now(),
      });

      const resumed = await storage.resumeExecution(id, TEST_ORG_ID);
      expect(resumed).toBe(false);
    });

    it("does not delete step results when organizationId does not match", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      // Create an incomplete step result
      await storage.createStepResult({
        execution_id: id,
        step_id: "incompleteStep",
      });

      await storage.cancelExecution(id, TEST_ORG_ID);

      // Attempt resume with wrong org — must not delete rows
      const resumed = await storage.resumeExecution(id, "wrong-org-id");
      expect(resumed).toBe(false);

      // Step result must still be intact
      const stepResult = await storage.getStepResult(id, "incompleteStep");
      expect(stepResult).not.toBeNull();

      // Execution must still be cancelled
      const execution = await storage.getExecution(id, TEST_ORG_ID);
      expect(execution!.status).toBe("cancelled");
    });
  });

  // --------------------------------------------------------------------------
  // createStepResult
  // --------------------------------------------------------------------------

  describe("createStepResult", () => {
    it("creates a step result with ON CONFLICT DO NOTHING", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      const result = await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
      });

      expect(result).not.toBeNull();
      expect(result!.execution_id).toBe(id);
      expect(result!.step_id).toBe("step1");
      expect(result!.started_at_epoch_ms).toBeNull();
    });

    it("returns null on duplicate (idempotent claim)", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      // First claim succeeds
      const first = await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
      });
      expect(first).not.toBeNull();

      // Second claim returns null (ON CONFLICT DO NOTHING)
      const second = await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
      });
      expect(second).toBeNull();
    });

    it("creates step result with output and completed_at", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      const result = await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
        output: { data: "result" },
        completed_at_epoch_ms: Date.now(),
      });

      expect(result).not.toBeNull();
      expect(result!.output).toEqual({ data: "result" });
      expect(result!.completed_at_epoch_ms).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getStepResultsByPrefix
  // --------------------------------------------------------------------------

  describe("getStepResultsByPrefix", () => {
    it("returns only matching iteration results", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      // Create parent step and iteration results
      await storage.createStepResult({
        execution_id: id,
        step_id: "forEach",
      });
      await storage.createStepResult({
        execution_id: id,
        step_id: "forEach[0]",
        output: "result0",
        completed_at_epoch_ms: Date.now(),
      });
      await storage.createStepResult({
        execution_id: id,
        step_id: "forEach[1]",
        output: "result1",
        completed_at_epoch_ms: Date.now(),
      });
      // Different step - should not be returned
      await storage.createStepResult({
        execution_id: id,
        step_id: "otherStep",
      });

      const results = await storage.getStepResultsByPrefix(id, "forEach[");
      expect(results).toHaveLength(2);
      expect(results[0].step_id).toBe("forEach[0]");
      expect(results[1].step_id).toBe("forEach[1]");
    });
  });

  // --------------------------------------------------------------------------
  // listExecutions
  // --------------------------------------------------------------------------

  describe("listExecutions", () => {
    it("lists executions with status filter", async () => {
      // Create workflow_collection for the join
      await db
        .insertInto("workflow_collection")
        .values({
          id: "wc_test",
          organization_id: TEST_ORG_ID,
          title: "Test Workflow",
          virtual_mcp_id: TEST_VIRTUAL_MCP_ID,
          steps: "[]",
          created_by: null,
          updated_by: null,
        })
        .execute();

      const { id: id1 } = await createTestExecution({
        workflowCollectionId: "wc_test",
      });
      const { id: id2 } = await createTestExecution({
        workflowCollectionId: "wc_test",
      });

      // Claim one to make it "running"
      await storage.claimExecution(id1);

      const enqueued = await storage.listExecutions(TEST_ORG_ID, {
        status: "enqueued",
      });
      expect(enqueued.items).toHaveLength(1);
      expect(enqueued.items[0].id).toBe(id2);

      const running = await storage.listExecutions(TEST_ORG_ID, {
        status: "running",
      });
      expect(running.items).toHaveLength(1);
      expect(running.items[0].id).toBe(id1);
    });

    it("supports pagination", async () => {
      await db
        .insertInto("workflow_collection")
        .values({
          id: "wc_test2",
          organization_id: TEST_ORG_ID,
          title: "Test Workflow",
          virtual_mcp_id: TEST_VIRTUAL_MCP_ID,
          steps: "[]",
          created_by: null,
          updated_by: null,
        })
        .execute();

      // Create 3 executions
      for (let i = 0; i < 3; i++) {
        await createTestExecution({ workflowCollectionId: "wc_test2" });
      }

      const page1 = await storage.listExecutions(TEST_ORG_ID, {
        limit: 2,
        offset: 0,
      });
      expect(page1.items).toHaveLength(2);
      expect(page1.totalCount).toBe(3);
      expect(page1.hasMore).toBe(true);

      const page2 = await storage.listExecutions(TEST_ORG_ID, {
        limit: 2,
        offset: 2,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getExecutionContext
  // --------------------------------------------------------------------------

  describe("getExecutionContext", () => {
    it("returns full execution context with step results", async () => {
      const { id } = await createTestExecution({
        input: { key: "value" },
      });
      await storage.claimExecution(id);

      await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
        output: { result: "done" },
        completed_at_epoch_ms: Date.now(),
      });

      const context = await storage.getExecutionContext(id);
      expect(context).not.toBeNull();
      expect(context!.execution.status).toBe("running");
      expect(context!.workflow.steps).toHaveLength(1);
      expect(context!.stepResults).toHaveLength(1);
      expect(context!.stepResults[0].output).toEqual({ result: "done" });
    });

    it("returns null for non-existent execution", async () => {
      const context = await storage.getExecutionContext("non_existent");
      expect(context).toBeNull();
    });
  });
});
