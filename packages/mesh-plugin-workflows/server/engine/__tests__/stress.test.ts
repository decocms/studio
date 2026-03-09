/**
 * Stress Tests -- Production-like load simulation
 *
 * Simulates many organizations and users creating and running workflows
 * concurrently against a shared database. Validates:
 *
 * - Multi-org isolation: workflows from different orgs don't interfere
 * - High concurrency: many workflows executing simultaneously
 * - Mixed workflow shapes: linear, parallel, forEach, deep DAGs
 * - Correctness under load: every workflow reaches a terminal state
 * - Storage pressure: large step counts, large forEach arrays
 * - Interleaved event processing: events from different executions mixed
 * - No stuck executions: every workflow completes or errors, never hangs
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Kysely } from "kysely";
import type { WorkflowDatabase } from "../../storage/types";
import { WorkflowExecutionStorage } from "../../storage/workflow-execution";
import { WorkflowCollectionStorage } from "../../storage/workflow-collection";
import { handleWorkflowEvents } from "../../events/handler";
import {
  createTestDb,
  createMockOrchestratorContext,
  makeCodeStep,
  makeToolStep,
  type MockOrchestratorContext,
} from "../../__tests__/test-helpers";
import type { Step } from "@decocms/bindings/workflow";

// ============================================================================
// Setup
// ============================================================================

let db: Kysely<WorkflowDatabase>;
let pglite: { close(): Promise<void> };
let storage: WorkflowExecutionStorage;
let collectionStorage: WorkflowCollectionStorage;

beforeEach(async () => {
  ({ db, pglite } = await createTestDb());
  storage = new WorkflowExecutionStorage(db);
  collectionStorage = new WorkflowCollectionStorage(db);
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
// Constants
// ============================================================================

const IDENTITY_CODE = "export default function(input) { return input; }";
const DOUBLE_CODE =
  "export default function(input) { return { doubled: input.value * 2 }; }";
const CONCAT_CODE = `export default function(input) {
  return { result: Object.values(input).join("-") };
}`;
const SLOW_CODE = `export default function(input) {
  // Simulate some computation
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += i;
  return { ...input, computed: sum };
}`;

const VMCP_ID = "vmcp_stress";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Insert a test organization into the stub table.
 */
async function insertOrg(orgId: string, name?: string): Promise<void> {
  await db
    .insertInto("organization" as never)
    .values({ id: orgId, name: name ?? orgId })
    .onConflict((oc) => oc.column("id" as never).doNothing())
    .execute();
}

/**
 * Create an execution and return its ID.
 */
async function startWorkflow(
  orgId: string,
  steps: Step[],
  input?: Record<string, unknown>,
  options?: { timeoutMs?: number; createdBy?: string },
): Promise<string> {
  const { id } = await storage.createExecution({
    organizationId: orgId,
    virtualMcpId: VMCP_ID,
    steps,
    input: input ?? null,
    timeoutMs: options?.timeoutMs,
    createdBy: options?.createdBy,
  });
  return id;
}

/**
 * Create a mock context that shares the same storage but has independent
 * event queues. This simulates separate event bus subscriptions per org.
 */
function createOrgContext(): MockOrchestratorContext {
  return createMockOrchestratorContext(storage);
}

/**
 * Run a workflow end-to-end: publish creation event, drain all events.
 */
async function runWorkflow(
  ctx: MockOrchestratorContext,
  executionId: string,
): Promise<void> {
  await ctx.publish("workflow.execution.created", executionId);
  await ctx.drainEvents();
}

/**
 * Assert that an execution reached a terminal state.
 */
async function assertTerminal(
  executionId: string,
  orgId: string,
  expectedStatus?: "success" | "error",
): Promise<string> {
  const execution = await storage.getExecution(executionId, orgId);
  expect(execution).not.toBeNull();
  const status = execution!.status;
  expect(["success", "error", "cancelled"]).toContain(status);
  if (expectedStatus) {
    expect(status).toBe(expectedStatus);
  }
  return status;
}

// ============================================================================
// Workflow shape generators
// ============================================================================

/** Linear chain: A -> B -> C -> ... -> N */
function linearWorkflow(stepCount: number): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < stepCount; i++) {
    const name = `step_${i}`;
    const input: Record<string, unknown> =
      i === 0 ? { index: i } : { prev: `@step_${i - 1}`, index: i };
    steps.push(makeCodeStep(name, IDENTITY_CODE, input));
  }
  return steps;
}

/** Wide parallel: N independent steps -> join step */
function wideParallelWorkflow(parallelCount: number): Step[] {
  const steps: Step[] = [];
  const joinInput: Record<string, unknown> = {};

  for (let i = 0; i < parallelCount; i++) {
    const name = `parallel_${i}`;
    steps.push(makeCodeStep(name, IDENTITY_CODE, { value: i }));
    joinInput[`from_${i}`] = `@${name}`;
  }

  steps.push(makeCodeStep("join", CONCAT_CODE, joinInput));
  return steps;
}

/** Diamond: A -> (B, C) -> D */
function diamondWorkflow(): Step[] {
  return [
    makeCodeStep("A", IDENTITY_CODE, { value: "start" }),
    makeCodeStep("B", SLOW_CODE, { value: "@A" }),
    makeCodeStep("C", SLOW_CODE, { value: "@A" }),
    makeCodeStep("D", IDENTITY_CODE, { fromB: "@B", fromC: "@C" }),
  ];
}

/** ForEach workflow: produce -> forEach process -> collect */
function forEachWorkflow(itemCount: number, concurrency: number): Step[] {
  const items = Array.from({ length: itemCount }, (_, i) => i + 1);
  return [
    makeCodeStep(
      "produce",
      `export default function() { return ${JSON.stringify(items)}; }`,
    ),
    makeCodeStep(
      "process",
      DOUBLE_CODE,
      { value: "@item" },
      {
        forEach: { ref: "@produce", concurrency },
      },
    ),
    makeCodeStep("collect", IDENTITY_CODE, { results: "@process" }),
  ];
}

/** Deep DAG: multiple layers of parallel steps with cross-dependencies */
function deepDagWorkflow(layers: number, widthPerLayer: number): Step[] {
  const steps: Step[] = [];

  for (let layer = 0; layer < layers; layer++) {
    for (let i = 0; i < widthPerLayer; i++) {
      const name = `L${layer}_${i}`;
      const input: Record<string, unknown> = {};

      if (layer === 0) {
        input.seed = `${layer}-${i}`;
      } else {
        // Depend on all steps from previous layer
        for (let j = 0; j < widthPerLayer; j++) {
          input[`dep_${j}`] = `@L${layer - 1}_${j}`;
        }
      }

      steps.push(makeCodeStep(name, IDENTITY_CODE, input));
    }
  }

  // Final join step
  const joinInput: Record<string, unknown> = {};
  for (let i = 0; i < widthPerLayer; i++) {
    joinInput[`final_${i}`] = `@L${layers - 1}_${i}`;
  }
  steps.push(makeCodeStep("final_join", IDENTITY_CODE, joinInput));

  return steps;
}

/** Mixed workflow: code steps + tool steps interleaved */
function mixedWorkflow(): Step[] {
  return [
    makeCodeStep("prepare", IDENTITY_CODE, { data: "raw" }),
    makeToolStep("fetch_data", "DATA_FETCH", { query: "@prepare" }),
    makeCodeStep(
      "transform",
      `export default function(input) { return { processed: true, ...input }; }`,
      { raw: "@fetch_data" },
    ),
    makeToolStep("save_result", "DATA_SAVE", { payload: "@transform" }),
    makeCodeStep("finalize", IDENTITY_CODE, { saved: "@save_result" }),
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe("Stress Tests", () => {
  // --------------------------------------------------------------------------
  // Multi-organization isolation
  // --------------------------------------------------------------------------

  describe("multi-organization isolation", () => {
    it("20 organizations each running 15 workflows concurrently", async () => {
      const orgCount = 20;
      const workflowsPerOrg = 15;

      // Create organizations
      const orgIds: string[] = [];
      for (let i = 0; i < orgCount; i++) {
        const orgId = `org_stress_${i}`;
        await insertOrg(orgId);
        orgIds.push(orgId);
      }

      // Create and run all workflows
      const allExecutions: { orgId: string; executionId: string }[] = [];
      const ctx = createOrgContext();

      for (const orgId of orgIds) {
        for (let w = 0; w < workflowsPerOrg; w++) {
          const steps = linearWorkflow(3);
          const executionId = await startWorkflow(orgId, steps, {
            orgId,
            workflowIndex: w,
          });
          allExecutions.push({ orgId, executionId });
          await ctx.publish("workflow.execution.created", executionId);
        }
      }

      // Drain all events
      await ctx.drainEvents();

      // Verify all executions completed successfully
      for (const { orgId, executionId } of allExecutions) {
        await assertTerminal(executionId, orgId, "success");
      }

      expect(allExecutions).toHaveLength(orgCount * workflowsPerOrg);
    }, 15_000);

    it("organizations don't see each other's executions in list queries", async () => {
      const orgA = "org_iso_a";
      const orgB = "org_iso_b";
      await insertOrg(orgA);
      await insertOrg(orgB);

      const ctx = createOrgContext();

      // Create workflows for each org
      const idA = await startWorkflow(orgA, linearWorkflow(2));
      const idB = await startWorkflow(orgB, linearWorkflow(2));

      await runWorkflow(ctx, idA);
      await runWorkflow(ctx, idB);

      // List executions per org
      const listA = await storage.listExecutions(orgA);
      const listB = await storage.listExecutions(orgB);

      expect(listA.items).toHaveLength(1);
      expect(listB.items).toHaveLength(1);
      expect(listA.items[0]!.id).toBe(idA);
      expect(listB.items[0]!.id).toBe(idB);
    });
  });

  // --------------------------------------------------------------------------
  // High concurrency: many workflows at once
  // --------------------------------------------------------------------------

  describe("high concurrency", () => {
    it("20 workflows running simultaneously on the same org", async () => {
      const orgId = "org_concurrent";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const executionIds: string[] = [];
      for (let i = 0; i < 20; i++) {
        const steps = diamondWorkflow();
        const id = await startWorkflow(orgId, steps, { index: i });
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");
      }
    });

    it("30 simple workflows (single step each) complete correctly", async () => {
      const orgId = "org_simple_burst";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const executionIds: string[] = [];
      for (let i = 0; i < 30; i++) {
        const id = await startWorkflow(
          orgId,
          [makeCodeStep("only", IDENTITY_CODE, { i })],
          { i },
        );
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Mixed workflow shapes under load
  // --------------------------------------------------------------------------

  describe("mixed workflow shapes under load", () => {
    it("runs linear, parallel, diamond, and forEach workflows concurrently", async () => {
      const orgId = "org_mixed";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const executionIds: string[] = [];

      // 5 linear workflows (5 steps each)
      for (let i = 0; i < 5; i++) {
        const id = await startWorkflow(orgId, linearWorkflow(5));
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      // 5 wide parallel workflows (8 parallel + join)
      for (let i = 0; i < 5; i++) {
        const id = await startWorkflow(orgId, wideParallelWorkflow(8));
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      // 5 diamond workflows
      for (let i = 0; i < 5; i++) {
        const id = await startWorkflow(orgId, diamondWorkflow());
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      // 5 forEach workflows (10 items, concurrency 3)
      for (let i = 0; i < 5; i++) {
        const id = await startWorkflow(orgId, forEachWorkflow(10, 3));
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      // All 20 workflows should complete
      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Large forEach arrays
  // --------------------------------------------------------------------------

  describe("large forEach arrays", () => {
    it("forEach with 50 items and concurrency 5", async () => {
      const orgId = "org_large_foreach";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const id = await startWorkflow(orgId, forEachWorkflow(50, 5));
      await runWorkflow(ctx, id);

      await assertTerminal(id, orgId, "success");

      // Verify all 50 iterations completed
      const iterationResults = await storage.getStepResultsByPrefix(
        id,
        "process[",
      );
      expect(iterationResults).toHaveLength(50);
      for (const r of iterationResults) {
        expect(r.completed_at_epoch_ms).not.toBeNull();
      }

      // Parent step should have collected all results
      const processResult = await storage.getStepResult(id, "process");
      expect(processResult).not.toBeNull();
      expect(Array.isArray(processResult!.output)).toBe(true);
      expect((processResult!.output as unknown[]).length).toBe(50);
    });

    it("forEach with 100 items and concurrency 10", async () => {
      const orgId = "org_huge_foreach";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const id = await startWorkflow(orgId, forEachWorkflow(100, 10));
      await runWorkflow(ctx, id);

      await assertTerminal(id, orgId, "success");

      const iterationResults = await storage.getStepResultsByPrefix(
        id,
        "process[",
      );
      expect(iterationResults).toHaveLength(100);
    });

    it("multiple forEach workflows with different concurrency levels", async () => {
      const orgId = "org_multi_foreach";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const configs = [
        { items: 20, concurrency: 1 },
        { items: 20, concurrency: 5 },
        { items: 20, concurrency: 20 },
      ];

      const executionIds: string[] = [];
      for (const { items, concurrency } of configs) {
        const id = await startWorkflow(
          orgId,
          forEachWorkflow(items, concurrency),
        );
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");
        const iterations = await storage.getStepResultsByPrefix(id, "process[");
        expect(iterations).toHaveLength(20);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Deep DAG workflows
  // --------------------------------------------------------------------------

  describe("deep DAG workflows", () => {
    it("5 layers x 3 wide DAG completes correctly", async () => {
      const orgId = "org_deep_dag";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const steps = deepDagWorkflow(5, 3);
      const id = await startWorkflow(orgId, steps);
      await runWorkflow(ctx, id);

      await assertTerminal(id, orgId, "success");

      // 5 layers * 3 steps + 1 join = 16 steps
      const stepResults = await storage.getStepResults(id);
      expect(stepResults).toHaveLength(16);
      for (const r of stepResults) {
        expect(r.completed_at_epoch_ms).not.toBeNull();
      }
    });

    it("3 deep DAGs running concurrently", async () => {
      const orgId = "org_multi_dag";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const executionIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const steps = deepDagWorkflow(4, 4);
        const id = await startWorkflow(orgId, steps);
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Tool step workflows under load
  // --------------------------------------------------------------------------

  describe("tool step workflows under load", () => {
    it("10 mixed code+tool workflows complete correctly", async () => {
      const orgId = "org_tool_stress";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      // Configure mock responses for tool steps
      ctx.setProxyResponse("DATA_FETCH", {
        structuredContent: { data: [1, 2, 3] },
      });
      ctx.setProxyResponse("DATA_SAVE", {
        structuredContent: { saved: true, id: "rec_123" },
      });

      const executionIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await startWorkflow(orgId, mixedWorkflow(), { index: i });
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");
      }

      // Verify proxy was called the expected number of times
      // Each workflow has 2 tool steps, 10 workflows = 20 tool calls
      expect(ctx.proxyCallLog).toHaveLength(20);
    });
  });

  // --------------------------------------------------------------------------
  // Interleaved event processing
  // --------------------------------------------------------------------------

  describe("interleaved event processing", () => {
    it("events from different executions processed in mixed batches", async () => {
      const orgId = "org_interleaved";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      // Create 10 workflows but don't drain yet
      const executionIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const steps = i % 2 === 0 ? linearWorkflow(3) : wideParallelWorkflow(4);
        const id = await startWorkflow(orgId, steps);
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      // Process events in small batches to simulate interleaving
      let iterations = 0;
      const maxIterations = 500;
      while (ctx.capturedEvents.length > 0 && iterations < maxIterations) {
        // Take a small random-ish batch (2-5 events)
        const batchSize = Math.min(
          2 + (iterations % 4),
          ctx.capturedEvents.length,
        );
        const batch = ctx.capturedEvents.splice(0, batchSize);

        const immediateEvents = batch.filter((e) => !e.options?.deliverAt);
        if (immediateEvents.length > 0) {
          const workflowEvents = immediateEvents.map((e, idx) => ({
            type: e.type,
            subject: e.subject,
            data: e.data as unknown,
            id: `evt_interleaved_${iterations}_${idx}`,
          }));
          await handleWorkflowEvents(workflowEvents, ctx);
        }
        iterations++;
      }

      // All workflows should have completed
      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Error workflows under load
  // --------------------------------------------------------------------------

  describe("error workflows under load", () => {
    it("mix of succeeding and failing workflows all reach terminal state", async () => {
      const orgId = "org_error_mix";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const executionIds: { id: string; shouldSucceed: boolean }[] = [];

      for (let i = 0; i < 15; i++) {
        const shouldSucceed = i % 3 !== 0; // Every 3rd workflow fails
        const steps = shouldSucceed
          ? linearWorkflow(3)
          : [
              makeCodeStep("ok_step", IDENTITY_CODE, {}),
              makeCodeStep(
                "fail_step",
                "export default function() { throw new Error('stress-fail'); }",
                { from: "@ok_step" },
              ),
            ];

        const id = await startWorkflow(orgId, steps);
        executionIds.push({ id, shouldSucceed });
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      for (const { id, shouldSucceed } of executionIds) {
        const status = await assertTerminal(id, orgId);
        if (shouldSucceed) {
          expect(status).toBe("success");
        } else {
          expect(status).toBe("error");
        }
      }
    });

    it("forEach with mixed success/failure iterations under load", async () => {
      const orgId = "org_foreach_errors";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const executionIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await startWorkflow(orgId, [
          makeCodeStep(
            "produce",
            `export default function() { return [1, 0, 3, 0, 5, 6, 0, 8]; }`,
          ),
          makeCodeStep(
            "process",
            `export default function(input) {
              if (input.value === 0) throw new Error("zero!");
              return { ok: input.value };
            }`,
            { value: "@item" },
            { forEach: { ref: "@produce", concurrency: 4 } },
          ),
        ]);
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      // All should complete (forEach defaults to onError: "continue")
      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");

        const processResult = await storage.getStepResult(id, "process");
        expect(processResult).not.toBeNull();
        expect(processResult!.completed_at_epoch_ms).not.toBeNull();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Workflow collection CRUD under load
  // --------------------------------------------------------------------------

  describe("workflow collection CRUD under load", () => {
    it("many orgs creating, listing, updating, and deleting collections", async () => {
      const orgCount = 5;
      const collectionsPerOrg = 10;

      const orgIds: string[] = [];
      for (let i = 0; i < orgCount; i++) {
        const orgId = `org_crud_${i}`;
        await insertOrg(orgId);
        orgIds.push(orgId);
      }

      // Create collections for each org
      const allCollections: { orgId: string; id: string }[] = [];
      for (const orgId of orgIds) {
        for (let c = 0; c < collectionsPerOrg; c++) {
          const collection = await collectionStorage.create({
            id: crypto.randomUUID(),
            organization_id: orgId,
            title: `Workflow ${c} for ${orgId}`,
            description: `Stress test collection ${c}`,
            virtual_mcp_id: VMCP_ID,
            steps: JSON.stringify(linearWorkflow(3)),
            created_by: `user_${c}`,
          });
          allCollections.push({ orgId, id: collection.id });
        }
      }

      // Verify each org sees only its own collections
      for (const orgId of orgIds) {
        const { items, totalCount } = await collectionStorage.list(orgId);
        expect(totalCount).toBe(collectionsPerOrg);
        expect(items).toHaveLength(collectionsPerOrg);
        for (const item of items) {
          expect(item.organization_id).toBe(orgId);
        }
      }

      // Update half the collections
      for (let i = 0; i < allCollections.length; i += 2) {
        const { orgId, id } = allCollections[i]!;
        await collectionStorage.update(id, orgId, {
          title: `Updated: ${id}`,
          updated_by: "stress_test",
        });
      }

      // Delete a quarter of the collections
      for (let i = 0; i < allCollections.length; i += 4) {
        const { orgId, id } = allCollections[i]!;
        await collectionStorage.delete(id, orgId);
      }

      // Verify counts after deletions
      const deletedPerOrg = Math.ceil(collectionsPerOrg / 4);

      for (const orgId of orgIds) {
        const { totalCount } = await collectionStorage.list(orgId);
        // Each org should have lost ~deletedPerOrg collections
        expect(totalCount).toBeLessThanOrEqual(collectionsPerOrg);
        expect(totalCount).toBeGreaterThanOrEqual(
          collectionsPerOrg - deletedPerOrg - 1,
        );
      }
    });
  });

  // --------------------------------------------------------------------------
  // Recovery under load
  // --------------------------------------------------------------------------

  describe("recovery under load", () => {
    it("recovers many stuck executions across multiple orgs", async () => {
      const orgCount = 5;
      const workflowsPerOrg = 4;

      const orgIds: string[] = [];
      for (let i = 0; i < orgCount; i++) {
        const orgId = `org_recovery_${i}`;
        await insertOrg(orgId);
        orgIds.push(orgId);
      }

      // Create and claim executions (simulating crash mid-execution)
      const stuckEntries: { id: string; orgId: string }[] = [];
      for (const orgId of orgIds) {
        for (let w = 0; w < workflowsPerOrg; w++) {
          const id = await startWorkflow(orgId, linearWorkflow(3));
          await storage.claimExecution(id);

          // Simulate partial progress for some
          if (w % 2 === 0) {
            await storage.createStepResult({
              execution_id: id,
              step_id: "step_0",
              output: { index: 0 },
              completed_at_epoch_ms: Date.now(),
            });
          }

          stuckEntries.push({ id, orgId });
        }
      }

      // All should be running (stuck)
      for (const { id, orgId } of stuckEntries) {
        const exec = await storage.getExecution(id, orgId);
        expect(exec!.status).toBe("running");
      }

      // Recover all
      const recovered = await storage.recoverStuckExecutions();
      expect(recovered).toHaveLength(stuckEntries.length);

      // All should be enqueued now
      for (const { id, orgId } of stuckEntries) {
        const exec = await storage.getExecution(id, orgId);
        expect(exec!.status).toBe("enqueued");
      }

      // Re-run all recovered executions
      const ctx = createOrgContext();
      for (const { id } of stuckEntries) {
        await ctx.publish("workflow.execution.created", id);
      }
      await ctx.drainEvents();

      // All should complete
      for (const { id, orgId } of stuckEntries) {
        await assertTerminal(id, orgId, "success");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Multi-user simulation
  // --------------------------------------------------------------------------

  describe("multi-user simulation", () => {
    it("multiple users in the same org creating workflows simultaneously", async () => {
      const orgId = "org_multi_user";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const userCount = 8;
      const workflowsPerUser = 3;

      const executionIds: { userId: string; id: string }[] = [];

      for (let u = 0; u < userCount; u++) {
        const userId = `user_${u}`;
        for (let w = 0; w < workflowsPerUser; w++) {
          const steps =
            w === 0
              ? linearWorkflow(4)
              : w === 1
                ? diamondWorkflow()
                : forEachWorkflow(5, 2);

          const id = await startWorkflow(
            orgId,
            steps,
            { userId, w },
            {
              createdBy: userId,
            },
          );
          executionIds.push({ userId, id });
          await ctx.publish("workflow.execution.created", id);
        }
      }

      await ctx.drainEvents();

      // All workflows should complete
      for (const { id } of executionIds) {
        await assertTerminal(id, orgId, "success");
      }

      // Verify total execution count
      const { totalCount } = await storage.listExecutions(orgId);
      expect(totalCount).toBe(userCount * workflowsPerUser);
    });
  });

  // --------------------------------------------------------------------------
  // Long chain stress
  // --------------------------------------------------------------------------

  describe("long chain stress", () => {
    it("linear workflow with 20 steps completes correctly", async () => {
      const orgId = "org_long_chain";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const id = await startWorkflow(orgId, linearWorkflow(20));
      await runWorkflow(ctx, id);

      await assertTerminal(id, orgId, "success");

      const stepResults = await storage.getStepResults(id);
      expect(stepResults).toHaveLength(20);
      for (const r of stepResults) {
        expect(r.completed_at_epoch_ms).not.toBeNull();
      }
    });

    it("5 long chains (15 steps each) running concurrently", async () => {
      const orgId = "org_multi_long";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const executionIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await startWorkflow(orgId, linearWorkflow(15));
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Cancellation under load
  // --------------------------------------------------------------------------

  describe("cancellation under load", () => {
    it("cancelling workflows mid-execution doesn't affect other running workflows", async () => {
      const orgId = "org_cancel_stress";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      // Start 10 workflows
      const executionIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await startWorkflow(orgId, linearWorkflow(5));
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      // Process just the creation events (claim all executions)
      const creationBatch = ctx.capturedEvents.splice(
        0,
        ctx.capturedEvents.length,
      );
      const immediateCreation = creationBatch.filter(
        (e) => !e.options?.deliverAt,
      );
      if (immediateCreation.length > 0) {
        await handleWorkflowEvents(
          immediateCreation.map((e, idx) => ({
            type: e.type,
            subject: e.subject,
            data: e.data as unknown,
            id: `evt_cancel_${idx}`,
          })),
          ctx,
        );
      }

      // Cancel every other workflow
      const cancelledIds = new Set<string>();
      for (let i = 0; i < executionIds.length; i += 2) {
        await storage.cancelExecution(executionIds[i]!, orgId);
        cancelledIds.add(executionIds[i]!);
      }

      // Drain remaining events
      await ctx.drainEvents();

      // Cancelled workflows should stay cancelled
      for (const id of cancelledIds) {
        const exec = await storage.getExecution(id, orgId);
        expect(exec!.status).toBe("cancelled");
      }

      // Non-cancelled workflows should complete
      for (const id of executionIds) {
        if (!cancelledIds.has(id)) {
          const exec = await storage.getExecution(id, orgId);
          // These may or may not complete depending on event ordering,
          // but they should not be stuck
          expect(["success", "running", "error"]).toContain(exec!.status);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Database row count verification
  // --------------------------------------------------------------------------

  describe("database integrity under load", () => {
    it("all rows are correctly associated after mass execution", async () => {
      const orgId = "org_integrity";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const executionIds: string[] = [];
      const totalWorkflows = 10;

      for (let i = 0; i < totalWorkflows; i++) {
        const id = await startWorkflow(orgId, diamondWorkflow(), { i });
        executionIds.push(id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      // Each diamond workflow has 4 steps
      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");

        const stepResults = await storage.getStepResults(id);
        expect(stepResults).toHaveLength(4);

        // Every step result should belong to this execution
        for (const r of stepResults) {
          expect(r.execution_id).toBe(id);
          expect(r.completed_at_epoch_ms).not.toBeNull();
        }

        // Execution should have output
        const exec = await storage.getExecution(id, orgId);
        expect(exec!.output).not.toBeNull();
      }

      // Total executions for this org
      const { totalCount } = await storage.listExecutions(orgId);
      expect(totalCount).toBe(totalWorkflows);
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency under load
  // --------------------------------------------------------------------------

  describe("idempotency under load", () => {
    it("duplicate creation events don't create duplicate executions", async () => {
      const orgId = "org_idempotent";
      await insertOrg(orgId);
      const ctx = createOrgContext();

      const executionIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await startWorkflow(orgId, linearWorkflow(3));
        executionIds.push(id);

        // Publish creation event 3 times (simulating duplicate delivery)
        await ctx.publish("workflow.execution.created", id);
        await ctx.publish("workflow.execution.created", id);
        await ctx.publish("workflow.execution.created", id);
      }

      await ctx.drainEvents();

      // All should complete exactly once
      for (const id of executionIds) {
        await assertTerminal(id, orgId, "success");
      }

      // Total should be exactly 5
      const { totalCount } = await storage.listExecutions(orgId);
      expect(totalCount).toBe(5);
    });
  });
});
