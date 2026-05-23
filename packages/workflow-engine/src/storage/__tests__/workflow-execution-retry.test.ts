/**
 * Workflow Execution Storage — Retry Operation Tests
 *
 * Tests for claimStepForRetry and resetStepResultForRetry.
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

async function createTestExecution() {
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
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("WorkflowExecutionStorage — retry operations", () => {
  // --------------------------------------------------------------------------
  // resetStepResultForRetry
  // --------------------------------------------------------------------------

  describe("resetStepResultForRetry", () => {
    it("clears fields and increments attempt", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      // Create step result and complete it with an error (simulating first attempt failure)
      await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
      });
      await storage.updateStepResult(id, "step1", {
        started_at_epoch_ms: Date.now(),
        completed_at_epoch_ms: Date.now(),
        output: { partial: true },
        error: "Something went wrong",
      });

      // Verify it has data before reset
      const beforeReset = await storage.getStepResult(id, "step1");
      expect(beforeReset).not.toBeNull();
      expect(beforeReset!.attempt_number).toBe(1);
      expect(beforeReset!.error).not.toBeNull();
      expect(beforeReset!.completed_at_epoch_ms).not.toBeNull();

      // Reset for retry
      await storage.resetStepResultForRetry(id, "step1", 2);

      const afterReset = await storage.getStepResult(id, "step1");
      expect(afterReset).not.toBeNull();
      expect(afterReset!.attempt_number).toBe(2);
      expect(afterReset!.started_at_epoch_ms).toBeNull();
      expect(afterReset!.completed_at_epoch_ms).toBeNull();
      expect(afterReset!.output).toBeNull();
      expect(afterReset!.error).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // claimStepForRetry
  // --------------------------------------------------------------------------

  describe("claimStepForRetry", () => {
    it("succeeds for matching attempt number", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      // Create step, complete it with error, then reset for retry
      await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
      });
      await storage.updateStepResult(id, "step1", {
        started_at_epoch_ms: Date.now(),
        completed_at_epoch_ms: Date.now(),
        error: "fail",
      });
      await storage.resetStepResultForRetry(id, "step1", 2);

      // Claim for retry attempt 2
      const claimed = await storage.claimStepForRetry(id, "step1", 2);
      expect(claimed).not.toBeNull();
      expect(claimed!.started_at_epoch_ms).not.toBeNull();
      expect(claimed!.attempt_number).toBe(2);
    });

    it("returns null on duplicate claim (second worker loses)", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
      });
      await storage.updateStepResult(id, "step1", {
        started_at_epoch_ms: Date.now(),
        completed_at_epoch_ms: Date.now(),
        error: "fail",
      });
      await storage.resetStepResultForRetry(id, "step1", 2);

      // First claim succeeds
      const first = await storage.claimStepForRetry(id, "step1", 2);
      expect(first).not.toBeNull();

      // Second claim returns null (started_at_epoch_ms is no longer null)
      const second = await storage.claimStepForRetry(id, "step1", 2);
      expect(second).toBeNull();
    });

    it("returns null for wrong attempt number", async () => {
      const { id } = await createTestExecution();
      await storage.claimExecution(id);

      await storage.createStepResult({
        execution_id: id,
        step_id: "step1",
      });
      await storage.updateStepResult(id, "step1", {
        started_at_epoch_ms: Date.now(),
        completed_at_epoch_ms: Date.now(),
        error: "fail",
      });
      await storage.resetStepResultForRetry(id, "step1", 2);

      // Try to claim with wrong attempt number (3 instead of 2)
      const claimed = await storage.claimStepForRetry(id, "step1", 3);
      expect(claimed).toBeNull();

      // Also wrong in the other direction (1 instead of 2)
      const claimedOld = await storage.claimStepForRetry(id, "step1", 1);
      expect(claimedOld).toBeNull();
    });
  });
});
