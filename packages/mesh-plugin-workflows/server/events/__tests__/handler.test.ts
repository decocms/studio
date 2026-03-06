import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Kysely } from "kysely";
import type { WorkflowDatabase } from "../../storage/types";
import { WorkflowExecutionStorage } from "../../storage/workflow-execution";
import { handleWorkflowEvents } from "../../events/handler";
import {
  createTestDb,
  createMockOrchestratorContext,
  makeCodeStep,
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

describe("handleWorkflowEvents", () => {
  it("routes workflow.execution.created to handleExecutionCreated", async () => {
    const ctx = createMockOrchestratorContext(storage);

    const { id } = await storage.createExecution({
      organizationId: TEST_ORG_ID,
      virtualMcpId: TEST_VIRTUAL_MCP_ID,
      steps: [
        makeCodeStep(
          "step1",
          "export default function(input) { return { result: 'ok' }; }",
        ),
      ],
    });

    await handleWorkflowEvents(
      [
        {
          type: "workflow.execution.created",
          subject: id,
          id: "evt_1",
        },
      ],
      ctx,
    );

    const execution = await storage.getExecution(id, TEST_ORG_ID);
    expect(execution!.status).toBe("running");
  });

  it("routes workflow.step.execute to handleStepExecute", async () => {
    const ctx = createMockOrchestratorContext(storage);

    const { id } = await storage.createExecution({
      organizationId: TEST_ORG_ID,
      virtualMcpId: TEST_VIRTUAL_MCP_ID,
      steps: [
        makeCodeStep(
          "step1",
          "export default function(input) { return input; }",
        ),
      ],
    });
    await storage.claimExecution(id);

    await handleWorkflowEvents(
      [
        {
          type: "workflow.step.execute",
          subject: id,
          data: {
            stepName: "step1",
          },
          id: "evt_2",
        },
      ],
      ctx,
    );

    // Step was claimed, executed, and started_at_epoch_ms set before execution
    const stepResult = await storage.getStepResult(id, "step1");
    expect(stepResult).not.toBeNull();
    expect(stepResult!.started_at_epoch_ms).not.toBeNull();
  });

  it("routes workflow.step.completed to handleStepCompleted", async () => {
    const ctx = createMockOrchestratorContext(storage);

    const { id } = await storage.createExecution({
      organizationId: TEST_ORG_ID,
      virtualMcpId: TEST_VIRTUAL_MCP_ID,
      steps: [
        makeCodeStep(
          "step1",
          "export default function(input) { return input; }",
        ),
      ],
    });
    await storage.claimExecution(id);

    await storage.createStepResult({
      execution_id: id,
      step_id: "step1",
    });
    await storage.updateStepResult(id, "step1", {
      output: { result: "done" },
      completed_at_epoch_ms: Date.now(),
    });

    await handleWorkflowEvents(
      [
        {
          type: "workflow.step.completed",
          subject: id,
          data: {
            stepName: "step1",
          },
          id: "evt_3",
        },
      ],
      ctx,
    );

    const stepResult = await storage.getStepResult(id, "step1");
    expect(stepResult).not.toBeNull();
    expect(stepResult!.completed_at_epoch_ms).not.toBeNull();
    expect(stepResult!.output).toEqual({ result: "done" });
  });

  it("skips events without subject", async () => {
    const ctx = createMockOrchestratorContext(storage);

    await handleWorkflowEvents(
      [
        {
          type: "workflow.execution.created",
          subject: undefined as unknown as string,
          id: "evt_4",
        },
      ],
      ctx,
    );

    expect(ctx.capturedEvents).toHaveLength(0);
  });

  it("skips workflow.step.execute without stepName in data", async () => {
    const ctx = createMockOrchestratorContext(storage);

    await handleWorkflowEvents(
      [
        {
          type: "workflow.step.execute",
          subject: "some_execution_id",
          data: {},
          id: "evt_5",
        },
      ],
      ctx,
    );

    expect(ctx.capturedEvents).toHaveLength(0);
  });

  it("handler errors don't affect other events in the batch", async () => {
    const ctx = createMockOrchestratorContext(storage);

    const { id } = await storage.createExecution({
      organizationId: TEST_ORG_ID,
      virtualMcpId: TEST_VIRTUAL_MCP_ID,
      steps: [
        makeCodeStep(
          "step1",
          "export default function(input) { return input; }",
        ),
      ],
    });

    await handleWorkflowEvents(
      [
        {
          type: "workflow.execution.created",
          subject: "non_existent_execution",
          id: "evt_6",
        },
        {
          type: "workflow.execution.created",
          subject: id,
          id: "evt_7",
        },
      ],
      ctx,
    );

    const execution = await storage.getExecution(id, TEST_ORG_ID);
    expect(execution!.status).toBe("running");
  });

  it("on handleStepExecute failure, publishes workflow.step.completed with error", async () => {
    const ctx = createMockOrchestratorContext(storage);

    const { id } = await storage.createExecution({
      organizationId: TEST_ORG_ID,
      virtualMcpId: TEST_VIRTUAL_MCP_ID,
      steps: [makeCodeStep("failStep", "this is not valid code!!!")],
    });
    await storage.claimExecution(id);

    await handleWorkflowEvents(
      [
        {
          type: "workflow.step.execute",
          subject: id,
          data: {
            stepName: "failStep",
          },
          id: "evt_8",
        },
      ],
      ctx,
    );

    const stepResult = await storage.getStepResult(id, "failStep");
    expect(stepResult).not.toBeNull();

    const completedEvents = ctx.capturedEvents.filter(
      (e) => e.type === "workflow.step.completed",
    );
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("returned promise resolves only after all handlers complete", async () => {
    const ctx = createMockOrchestratorContext(storage);

    const { id: id1 } = await storage.createExecution({
      organizationId: TEST_ORG_ID,
      virtualMcpId: TEST_VIRTUAL_MCP_ID,
      steps: [
        makeCodeStep(
          "step1",
          "export default function(input) { return { result: 'ok' }; }",
        ),
      ],
    });
    const { id: id2 } = await storage.createExecution({
      organizationId: TEST_ORG_ID,
      virtualMcpId: TEST_VIRTUAL_MCP_ID,
      steps: [
        makeCodeStep(
          "step1",
          "export default function(input) { return { result: 'ok' }; }",
        ),
      ],
    });

    await handleWorkflowEvents(
      [
        {
          type: "workflow.execution.created",
          subject: id1,
          id: "evt_9",
        },
        {
          type: "workflow.execution.created",
          subject: id2,
          id: "evt_10",
        },
      ],
      ctx,
    );

    const execution1 = await storage.getExecution(id1, TEST_ORG_ID);
    const execution2 = await storage.getExecution(id2, TEST_ORG_ID);
    expect(execution1!.status).toBe("running");
    expect(execution2!.status).toBe("running");
  });
});
