/**
 * Bail / Early Return Tests
 *
 * Bail is post-execution only: the step runs, and if the bail condition is met
 * on the step's output, the workflow exits early with that step's output.
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
import type { Step } from "@decocms/bindings/workflow";

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

function parseOutput(output: string | null): unknown {
  return output ? JSON.parse(output) : null;
}

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

describe("Bail / Early Return", () => {
  describe("unconditional bail", () => {
    it("runs step then exits workflow with step output", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep("A", IDENTITY_CODE, { value: "early" }),
        bail: true,
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      expect(parseOutput(execution!.output)).toEqual({ value: "early" });

      // Step B should never have been dispatched
      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults.find((r) => r.step_id === "B")).toBeUndefined();
    });
  });

  describe("conditional bail (eq)", () => {
    it("exits early when own output matches condition", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep(
          "A",
          'export default function(input) { return { done: true, result: "found" }; }',
          {},
        ),
        bail: { ref: "@A.done", eq: true },
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      expect(parseOutput(execution!.output)).toEqual({
        done: true,
        result: "found",
      });

      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults.find((r) => r.step_id === "B")).toBeUndefined();
    });

    it("continues when own output does NOT match condition", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep(
          "A",
          'export default function(input) { return { done: false, result: "not yet" }; }',
          {},
        ),
        bail: { ref: "@A.done", eq: true },
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");

      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults).toHaveLength(2);
    });
  });

  describe("conditional bail (neq)", () => {
    it("exits early when value does NOT equal neq", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep(
          "A",
          'export default function(input) { return { status: "error" }; }',
          {},
        ),
        bail: { ref: "@A.status", neq: "ok" },
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      expect(parseOutput(execution!.output)).toEqual({ status: "error" });
    });
  });

  describe("conditional bail (gt / lt)", () => {
    it("exits early when value > gt threshold", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep(
          "A",
          "export default function(input) { return { score: 95 }; }",
          {},
        ),
        bail: { ref: "@A.score", gt: 90 },
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      expect(parseOutput(execution!.output)).toEqual({ score: 95 });
    });

    it("continues when value <= gt threshold", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep(
          "A",
          "export default function(input) { return { score: 50 }; }",
          {},
        ),
        bail: { ref: "@A.score", gt: 90 },
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults).toHaveLength(2);
    });

    it("exits early when value < lt threshold", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep(
          "A",
          "export default function(input) { return { count: 0 }; }",
          {},
        ),
        bail: { ref: "@A.count", lt: 1 },
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      expect(parseOutput(execution!.output)).toEqual({ count: 0 });
    });
  });

  describe("conditional bail (truthy — no operator)", () => {
    it("exits early when ref resolves to truthy value", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep(
          "A",
          'export default function(input) { return { shouldStop: "yes" }; }',
          {},
        ),
        bail: { ref: "@A.shouldStop" },
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      expect(parseOutput(execution!.output)).toEqual({ shouldStop: "yes" });
    });

    it("continues when ref resolves to falsy value", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep(
          "A",
          "export default function(input) { return { shouldStop: false }; }",
          {},
        ),
        bail: { ref: "@A.shouldStop" },
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults).toHaveLength(2);
    });
  });

  describe("bail on step error", () => {
    it("does NOT bail when the step errors", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA: Step = {
        ...makeCodeStep(
          "A",
          'export default function(input) { throw new Error("boom"); }',
          {},
        ),
        bail: { ref: "@A.done", eq: true },
        config: { onError: "continue" },
      };
      const stepB = makeCodeStep("B", IDENTITY_CODE, { value: "reached" });

      const executionId = await startWorkflow([stepA, stepB]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");

      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults.find((r) => r.step_id === "B")).toBeDefined();
    });
  });

  describe("bail with downstream steps", () => {
    it("never dispatches steps downstream of the bailing step", async () => {
      const ctx = createMockOrchestratorContext(storage);

      // A -> B (bail on own output) -> C -> D
      const stepA = makeCodeStep("A", IDENTITY_CODE, { v: 1 });
      const stepB: Step = {
        ...makeCodeStep("B", IDENTITY_CODE, { fromA: "@A" }),
        bail: { ref: "@B.fromA" },
      };
      const stepC = makeCodeStep("C", IDENTITY_CODE, { fromB: "@B" });
      const stepD = makeCodeStep("D", IDENTITY_CODE, { fromC: "@C" });

      const executionId = await startWorkflow([stepA, stepB, stepC, stepD]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      expect(parseOutput(execution!.output)).toEqual({ fromA: { v: 1 } });

      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults.find((r) => r.step_id === "C")).toBeUndefined();
      expect(stepResults.find((r) => r.step_id === "D")).toBeUndefined();
    });
  });

  describe("bail on forEach parent", () => {
    it("exits early after forEach completes when bail condition is met", async () => {
      const ctx = createMockOrchestratorContext(storage);

      const stepA = makeCodeStep(
        "A",
        "export default function() { return { items: [1, 2, 3] }; }",
        {},
      );
      const stepB: Step = {
        ...makeCodeStep("B", IDENTITY_CODE, { item: "@item" }),
        forEach: { ref: "@A.items", concurrency: 3 },
        bail: { ref: "@B" },
      };
      const stepC = makeCodeStep("C", IDENTITY_CODE, { fromB: "@B" });

      const executionId = await startWorkflow([stepA, stepB, stepC]);
      await ctx.publish("workflow.execution.created", executionId);
      await ctx.drainEvents();

      const execution = await storage.getExecution(executionId, TEST_ORG_ID);
      expect(execution!.status).toBe("success");
      expect(parseOutput(execution!.output)).toEqual([
        { item: 1 },
        { item: 2 },
        { item: 3 },
      ]);

      const stepResults = await storage.getStepResults(executionId);
      expect(stepResults.find((r) => r.step_id === "C")).toBeUndefined();
    });
  });
});
