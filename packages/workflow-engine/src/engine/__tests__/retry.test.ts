/**
 * Orchestrator Retry Tests
 *
 * Tests for step-level retry with maxAttempts, backoff, and deadline awareness.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Kysely } from "kysely";
import type { Step } from "@decocms/bindings/workflow";
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

const FAIL_CODE =
  "export default function() { throw new Error('step failed'); }";

function makeCodeStepWithConfig(
  name: string,
  code: string,
  input: Record<string, unknown>,
  config: Step["config"],
): Step {
  return {
    name,
    action: { code },
    input,
    config,
  } as Step;
}

async function startWorkflow(
  steps: Parameters<WorkflowExecutionStorage["createExecution"]>[0]["steps"],
  input?: Record<string, unknown>,
  options?: { timeoutMs?: number },
) {
  const { id } = await storage.createExecution({
    organizationId: TEST_ORG_ID,
    virtualMcpId: TEST_VIRTUAL_MCP_ID,
    steps,
    input: input ?? null,
    timeoutMs: options?.timeoutMs,
  });
  return id;
}

// ============================================================================
// Tests
// ============================================================================

describe("Orchestrator — step retries", () => {
  it("step with maxAttempts:2 retries on failure", async () => {
    const ctx = createMockOrchestratorContext(storage);

    const executionId = await startWorkflow([
      makeCodeStepWithConfig(
        "failOnce",
        FAIL_CODE,
        {},
        {
          maxAttempts: 2,
          backoffMs: 100,
        },
      ),
    ]);

    await ctx.publish("workflow.execution.created", executionId);
    await ctx.drainEvents();

    // The step should have failed on attempt 1, then a scheduled retry event
    // should have been produced (not processed immediately).
    expect(ctx.scheduledEvents.length).toBeGreaterThanOrEqual(1);

    const retryEvent = ctx.scheduledEvents.find(
      (e) =>
        e.type === "workflow.step.execute" &&
        (e.data as Record<string, unknown>)?.stepName === "failOnce",
    );
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.options?.deliverAt).toBeDefined();

    // The step result should have been reset for retry (attempt_number incremented, fields cleared)
    const stepResult = await storage.getStepResult(executionId, "failOnce");
    expect(stepResult).not.toBeNull();
    expect(stepResult!.attempt_number).toBe(2);
    expect(stepResult!.started_at_epoch_ms).toBeNull();
    expect(stepResult!.completed_at_epoch_ms).toBeNull();
    expect(stepResult!.error).toBeNull();

    // Execution should still be running (waiting for retry)
    const execution = await storage.getExecution(executionId, TEST_ORG_ID);
    expect(execution!.status).toBe("running");
  });

  it("step with maxAttempts:1 (default) does not retry", async () => {
    const ctx = createMockOrchestratorContext(storage);

    // No config = default maxAttempts:1
    const executionId = await startWorkflow([
      makeCodeStep("failNoRetry", FAIL_CODE, {}),
    ]);

    await ctx.publish("workflow.execution.created", executionId);
    await ctx.drainEvents();

    // No scheduled retry events
    const retryEvents = ctx.scheduledEvents.filter(
      (e) =>
        e.type === "workflow.step.execute" &&
        (e.data as Record<string, unknown>)?.stepName === "failNoRetry",
    );
    expect(retryEvents).toHaveLength(0);

    // Execution should have failed directly
    const execution = await storage.getExecution(executionId, TEST_ORG_ID);
    expect(execution!.status).toBe("error");
  });

  it("retry skipped when would exceed deadline", async () => {
    const ctx = createMockOrchestratorContext(storage);

    // Create execution with a very tight deadline (1ms timeout)
    const executionId = await startWorkflow(
      [
        makeCodeStepWithConfig(
          "failDeadline",
          FAIL_CODE,
          {},
          {
            maxAttempts: 3,
            backoffMs: 1000, // 1s backoff — will exceed the deadline
          },
        ),
      ],
      undefined,
      { timeoutMs: 50 }, // 50ms timeout
    );

    // Small delay to let some time pass but not exceed deadline at claim time
    await new Promise((r) => setTimeout(r, 10));

    await ctx.publish("workflow.execution.created", executionId);
    await ctx.drainEvents();

    // No scheduled retry events — backoff would exceed the deadline
    const retryEvents = ctx.scheduledEvents.filter(
      (e) =>
        e.type === "workflow.step.execute" &&
        (e.data as Record<string, unknown>)?.stepName === "failDeadline",
    );
    expect(retryEvents).toHaveLength(0);

    // Execution should be in error state (either deadline exceeded or step failure)
    const execution = await storage.getExecution(executionId, TEST_ORG_ID);
    expect(execution!.status).toBe("error");
  });

  it("retry exhaustion falls through to error handling", async () => {
    const ctx = createMockOrchestratorContext(storage);

    const executionId = await startWorkflow([
      makeCodeStepWithConfig(
        "failAlways",
        FAIL_CODE,
        {},
        {
          maxAttempts: 2,
          backoffMs: 100,
        },
      ),
    ]);

    await ctx.publish("workflow.execution.created", executionId);
    await ctx.drainEvents();

    // First attempt failed, retry was scheduled
    expect(ctx.scheduledEvents.length).toBeGreaterThanOrEqual(1);

    // Now simulate the retry arriving: move scheduled events back to captured and drain
    // This simulates the event bus delivering the delayed event
    for (const evt of ctx.scheduledEvents) {
      ctx.capturedEvents.push({ ...evt, options: undefined });
    }
    ctx.scheduledEvents.length = 0;
    await ctx.drainEvents();

    // After attempt 2 (the last allowed), no more retries should be scheduled
    const secondRetryEvents = ctx.scheduledEvents.filter(
      (e) =>
        e.type === "workflow.step.execute" &&
        (e.data as Record<string, unknown>)?.stepName === "failAlways",
    );
    expect(secondRetryEvents).toHaveLength(0);

    // Execution should have failed (retry exhausted, onError: "fail" default)
    const execution = await storage.getExecution(executionId, TEST_ORG_ID);
    expect(execution!.status).toBe("error");
  });
});
