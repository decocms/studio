import type { Kysely, Transaction } from "kysely";
import type {
  WorkflowDatabase,
  WorkflowRow,
  WorkflowExecutionRow,
  StepResultRow,
  ExecutionStatus,
} from "./types";
import type { Step } from "@decocms/bindings/workflow";
import { parseJson } from "../types";

export interface ParsedWorkflow {
  id: string;
  workflow_collection_id: string | null;
  organization_id: string;
  steps: Step[];
  input: Record<string, unknown> | null;
  virtual_mcp_id: string;
  created_at_epoch_ms: number;
  created_by: string | null;
}

export interface ParsedStepResult {
  execution_id: string;
  step_id: string;
  started_at_epoch_ms: number | null;
  completed_at_epoch_ms: number | null;
  output: unknown;
  error: unknown;
  raw_tool_output: unknown;
}

export interface ExecutionContext {
  execution: {
    id: string;
    status: ExecutionStatus;
    workflow_id: string;
    deadline_at_epoch_ms: number | null;
  };
  workflow: {
    steps: Step[];
    input: Record<string, unknown> | null;
    virtual_mcp_id: string;
  };
  stepResults: ParsedStepResult[];
}

function parseWorkflow(row: WorkflowRow): ParsedWorkflow {
  return {
    ...row,
    steps: (parseJson(row.steps) as Step[]) ?? [],
    input: (parseJson(row.input) as Record<string, unknown>) ?? null,
  };
}

function parseStepResult(row: StepResultRow): ParsedStepResult {
  return {
    ...row,
    output: parseJson(row.output),
    error: parseJson(row.error),
    raw_tool_output: parseJson(row.raw_tool_output),
  };
}

export class WorkflowExecutionStorage {
  constructor(private db: Kysely<WorkflowDatabase>) {}

  private async _createWorkflow(
    trx: Kysely<WorkflowDatabase> | Transaction<WorkflowDatabase>,
    data: {
      organizationId: string;
      workflowCollectionId?: string | null;
      virtualMcpId: string;
      input?: Record<string, unknown> | null;
      steps: Step[];
      createdBy?: string | null;
    },
  ): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    const now = Date.now();

    await trx
      .insertInto("workflow")
      .values({
        id,
        workflow_collection_id: data.workflowCollectionId ?? null,
        organization_id: data.organizationId,
        steps: JSON.stringify(data.steps),
        input: data.input ? JSON.stringify(data.input) : null,
        virtual_mcp_id: data.virtualMcpId,
        created_at_epoch_ms: now,
        created_by: data.createdBy ?? null,
      })
      .execute();

    return { id };
  }

  async createWorkflow(data: {
    organizationId: string;
    workflowCollectionId?: string | null;
    virtualMcpId: string;
    input?: Record<string, unknown> | null;
    steps: Step[];
    createdBy?: string | null;
  }): Promise<{ id: string }> {
    return this._createWorkflow(this.db, data);
  }

  async getWorkflow(id: string): Promise<ParsedWorkflow | null> {
    const row = await this.db
      .selectFrom("workflow")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? parseWorkflow(row) : null;
  }

  async createExecution(data: {
    organizationId: string;
    virtualMcpId: string;
    input?: Record<string, unknown> | null;
    steps: Step[];
    timeoutMs?: number | null;
    startAtEpochMs?: number | null;
    workflowCollectionId?: string | null;
    createdBy?: string | null;
  }): Promise<{ id: string }> {
    return this.db.transaction().execute(async (trx) => {
      const now = Date.now();

      // Create immutable workflow snapshot (inside transaction)
      const { id: workflowId } = await this._createWorkflow(trx, {
        organizationId: data.organizationId,
        workflowCollectionId: data.workflowCollectionId,
        virtualMcpId: data.virtualMcpId,
        input: data.input,
        steps: data.steps,
        createdBy: data.createdBy,
      });

      const executionId = crypto.randomUUID();
      const startAtEpochMs = data.startAtEpochMs ?? now;
      const deadlineAtEpochMs = data.timeoutMs
        ? startAtEpochMs + data.timeoutMs
        : null;

      await trx
        .insertInto("workflow_execution")
        .values({
          id: executionId,
          workflow_id: workflowId,
          organization_id: data.organizationId,
          status: "enqueued",
          input: data.input ? JSON.stringify(data.input) : null,
          created_at: now,
          updated_at: now,
          start_at_epoch_ms: startAtEpochMs,
          timeout_ms: data.timeoutMs ?? null,
          deadline_at_epoch_ms: deadlineAtEpochMs,
          created_by: data.createdBy ?? null,
        })
        .execute();

      return { id: executionId };
    });
  }

  async getExecution(
    id: string,
    organizationId: string,
  ): Promise<WorkflowExecutionRow | null> {
    const row = await this.db
      .selectFrom("workflow_execution")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return row ?? null;
  }

  async getExecutionFull(
    id: string,
    organizationId: string,
  ): Promise<{
    execution: WorkflowExecutionRow;
    stepResults: ParsedStepResult[];
  } | null> {
    const execution = await this.db
      .selectFrom("workflow_execution")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!execution) return null;

    const stepResults = await this.db
      .selectFrom("workflow_execution_step_result")
      .selectAll()
      .where("execution_id", "=", id)
      .execute();

    return {
      execution,
      stepResults: stepResults.map(parseStepResult),
    };
  }

  /**
   * Get execution context in minimal queries for orchestration.
   */
  async getExecutionContext(
    executionId: string,
  ): Promise<ExecutionContext | null> {
    const execution = await this.db
      .selectFrom("workflow_execution")
      .select(["id", "status", "workflow_id", "deadline_at_epoch_ms"])
      .where("id", "=", executionId)
      .executeTakeFirst();

    if (!execution) return null;

    const workflowRow = await this.db
      .selectFrom("workflow")
      .select(["steps", "input", "virtual_mcp_id"])
      .where("id", "=", execution.workflow_id)
      .executeTakeFirst();

    if (!workflowRow) return null;

    const stepResultRows = await this.db
      .selectFrom("workflow_execution_step_result")
      .selectAll()
      .where("execution_id", "=", executionId)
      .execute();

    return {
      execution: {
        id: execution.id,
        status: execution.status,
        workflow_id: execution.workflow_id,
        deadline_at_epoch_ms: execution.deadline_at_epoch_ms,
      },
      workflow: {
        steps: (parseJson(workflowRow.steps) as Step[]) ?? [],
        input:
          (parseJson(workflowRow.input) as Record<string, unknown>) ?? null,
        virtual_mcp_id: workflowRow.virtual_mcp_id,
      },
      stepResults: stepResultRows.map(parseStepResult),
    };
  }

  /**
   * Atomic claim: only succeeds if status is 'enqueued'.
   */
  async claimExecution(executionId: string): Promise<{
    execution: WorkflowExecutionRow;
    workflow: ParsedWorkflow;
  } | null> {
    const now = Date.now();

    const updated = await this.db
      .updateTable("workflow_execution")
      .set({ status: "running", updated_at: now })
      .where("id", "=", executionId)
      .where("status", "=", "enqueued")
      .returningAll()
      .executeTakeFirst();

    if (!updated) return null;

    const workflow = await this.getWorkflow(updated.workflow_id);
    if (!workflow) {
      throw new Error(
        `Workflow ${updated.workflow_id} not found for execution ${executionId}`,
      );
    }

    return { execution: updated, workflow };
  }

  async updateExecution(
    id: string,
    data: {
      status?: ExecutionStatus;
      output?: unknown;
      error?: string;
      completed_at_epoch_ms?: number;
    },
    options?: { onlyIfStatus?: ExecutionStatus },
  ): Promise<WorkflowExecutionRow | null> {
    const now = Date.now();
    const setValues: Record<string, unknown> = { updated_at: now };

    if (data.status !== undefined) setValues.status = data.status;
    if (data.output !== undefined)
      setValues.output = JSON.stringify(data.output);
    if (data.error !== undefined) setValues.error = JSON.stringify(data.error);
    if (data.completed_at_epoch_ms !== undefined)
      setValues.completed_at_epoch_ms = data.completed_at_epoch_ms;

    let query = this.db
      .updateTable("workflow_execution")
      .set(setValues)
      .where("id", "=", id);

    if (options?.onlyIfStatus) {
      query = query.where("status", "=", options.onlyIfStatus);
    }

    const row = await query.returningAll().executeTakeFirst();
    return row ?? null;
  }

  async cancelExecution(
    executionId: string,
    organizationId: string,
  ): Promise<boolean> {
    const now = Date.now();
    const result = await this.db
      .updateTable("workflow_execution")
      .set({ status: "cancelled", updated_at: now })
      .where("id", "=", executionId)
      .where("organization_id", "=", organizationId)
      .where("status", "in", ["enqueued", "running"])
      .returningAll()
      .executeTakeFirst();

    return !!result;
  }

  async resumeExecution(
    executionId: string,
    organizationId: string,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const now = Date.now();

      // Clear claimed-but-not-completed step results
      await trx
        .deleteFrom("workflow_execution_step_result")
        .where("execution_id", "=", executionId)
        .where("completed_at_epoch_ms", "is", null)
        .execute();

      const result = await trx
        .updateTable("workflow_execution")
        .set({
          status: "enqueued",
          updated_at: now,
          completed_at_epoch_ms: null,
        })
        .where("id", "=", executionId)
        .where("organization_id", "=", organizationId)
        .where("status", "=", "cancelled")
        .returningAll()
        .executeTakeFirst();

      return !!result;
    });
  }

  async listExecutions(
    organizationId: string,
    options: { limit?: number; offset?: number; status?: string } = {},
  ): Promise<{
    items: (WorkflowExecutionRow & {
      title: string;
      virtual_mcp_id: string;
    })[];
    totalCount: number;
    hasMore: boolean;
  }> {
    const { limit = 50, offset = 0, status } = options;

    let query = this.db
      .selectFrom("workflow_execution as we")
      .innerJoin("workflow as w", "we.workflow_id", "w.id")
      .leftJoin(
        "workflow_collection as wc",
        "w.workflow_collection_id",
        "wc.id",
      )
      .select([
        "we.id",
        "we.workflow_id",
        "we.organization_id",
        "we.status",
        "we.input",
        "we.output",
        "we.error",
        "we.created_at",
        "we.updated_at",
        "we.start_at_epoch_ms",
        "we.started_at_epoch_ms",
        "we.completed_at_epoch_ms",
        "we.timeout_ms",
        "we.deadline_at_epoch_ms",
        "we.created_by",
        "w.virtual_mcp_id",
      ])
      .select((eb) =>
        eb.fn.coalesce("wc.title", eb.val("Workflow Execution")).as("title"),
      )
      .where("we.organization_id", "=", organizationId);

    if (status) {
      query = query.where(
        "we.status",
        "=",
        status as unknown as ExecutionStatus,
      );
    }

    const items = await query
      .orderBy("we.created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    let countQuery = this.db
      .selectFrom("workflow_execution")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("organization_id", "=", organizationId);

    if (status) {
      countQuery = countQuery.where(
        "status",
        "=",
        status as unknown as ExecutionStatus,
      );
    }

    const countResult = await countQuery.executeTakeFirstOrThrow();
    const totalCount = Number(countResult.count);

    return {
      items: items as (WorkflowExecutionRow & {
        title: string;
        virtual_mcp_id: string;
      })[],
      totalCount,
      hasMore: offset + items.length < totalCount,
    };
  }

  /**
   * Claim a step. Uses INSERT ... ON CONFLICT DO NOTHING for idempotency.
   * Returns the row if we won the race, null if another worker claimed it.
   * `started_at_epoch_ms` is null — set it right before actual execution.
   */
  async createStepResult(data: {
    execution_id: string;
    step_id: string;
    output?: unknown;
    error?: string;
    completed_at_epoch_ms?: number;
  }): Promise<ParsedStepResult | null> {
    const row = await this.db
      .insertInto("workflow_execution_step_result")
      .values({
        execution_id: data.execution_id,
        step_id: data.step_id,
        started_at_epoch_ms: data.completed_at_epoch_ms ? Date.now() : null,
        completed_at_epoch_ms: data.completed_at_epoch_ms ?? null,
        output: data.output !== undefined ? JSON.stringify(data.output) : null,
        error: data.error !== undefined ? JSON.stringify(data.error) : null,
      })
      .onConflict((oc) => oc.columns(["execution_id", "step_id"]).doNothing())
      .returningAll()
      .executeTakeFirst();

    return row ? parseStepResult(row) : null;
  }

  async updateStepResult(
    executionId: string,
    stepId: string,
    data: {
      output?: unknown;
      error?: string;
      started_at_epoch_ms?: number;
      completed_at_epoch_ms?: number;
    },
  ): Promise<ParsedStepResult | null> {
    const setValues: Record<string, unknown> = {};

    if (data.output !== undefined)
      setValues.output = JSON.stringify(data.output);
    if (data.error !== undefined) setValues.error = JSON.stringify(data.error);
    if (data.started_at_epoch_ms !== undefined)
      setValues.started_at_epoch_ms = data.started_at_epoch_ms;
    if (data.completed_at_epoch_ms !== undefined)
      setValues.completed_at_epoch_ms = data.completed_at_epoch_ms;

    if (Object.keys(setValues).length === 0) return null;

    const row = await this.db
      .updateTable("workflow_execution_step_result")
      .set(setValues)
      .where("execution_id", "=", executionId)
      .where("step_id", "=", stepId)
      .returningAll()
      .executeTakeFirst();

    return row ? parseStepResult(row) : null;
  }

  /**
   * Checkpoint raw tool output and apply a transform.
   *
   * 1. Persists `rawToolOutput` to the step result row (checkpoint).
   * 2. Runs `transformFn` outside the DB connection to produce the final output.
   * 3. Persists the transformed output (or error) and marks the step completed.
   *
   * Each DB write is a separate operation so the transform (which may be
   * CPU-intensive, e.g. QuickJS sandbox with up to 10 s timeout) never holds
   * a connection open. The raw checkpoint is committed first, guaranteeing it
   * survives even if the transform or the final persist fails.
   */
  async checkpointAndTransform(
    executionId: string,
    stepId: string,
    rawToolOutput: unknown,
    transformFn: (
      raw: unknown,
    ) => Promise<{ output?: unknown; error?: string }>,
  ): Promise<ParsedStepResult | null> {
    // 1. Checkpoint: persist the raw tool output (separate write)
    await this.db
      .updateTable("workflow_execution_step_result")
      .set({
        raw_tool_output: JSON.stringify(rawToolOutput),
      })
      .where("execution_id", "=", executionId)
      .where("step_id", "=", stepId)
      .execute();

    // 2. Run the transform — no DB connection held
    let output: unknown;
    let error: string | undefined;
    try {
      const result = await transformFn(rawToolOutput);
      output = result.output;
      error = result.error;
    } catch (err) {
      error =
        err instanceof Error
          ? `Transform failed: ${err.message}`
          : `Transform failed: ${String(err)}`;
    }

    // 3. Persist the final result (separate write)
    const setValues: Record<string, unknown> = {
      completed_at_epoch_ms: Date.now(),
    };
    if (output !== undefined) setValues.output = JSON.stringify(output);
    if (error !== undefined) setValues.error = JSON.stringify(error);

    const row = await this.db
      .updateTable("workflow_execution_step_result")
      .set(setValues)
      .where("execution_id", "=", executionId)
      .where("step_id", "=", stepId)
      .returningAll()
      .executeTakeFirst();

    return row ? parseStepResult(row) : null;
  }

  async getStepResult(
    executionId: string,
    stepId: string,
  ): Promise<ParsedStepResult | null> {
    const row = await this.db
      .selectFrom("workflow_execution_step_result")
      .selectAll()
      .where("execution_id", "=", executionId)
      .where("step_id", "=", stepId)
      .executeTakeFirst();

    return row ? parseStepResult(row) : null;
  }

  async getStepResults(executionId: string): Promise<ParsedStepResult[]> {
    const rows = await this.db
      .selectFrom("workflow_execution_step_result")
      .selectAll()
      .where("execution_id", "=", executionId)
      .execute();

    return rows.map(parseStepResult);
  }

  async deleteStepResult(executionId: string, stepId: string): Promise<void> {
    await this.db
      .deleteFrom("workflow_execution_step_result")
      .where("execution_id", "=", executionId)
      .where("step_id", "=", stepId)
      .execute();
  }

  async getStepResultsByPrefix(
    executionId: string,
    prefix: string,
  ): Promise<ParsedStepResult[]> {
    const rows = await this.db
      .selectFrom("workflow_execution_step_result")
      .selectAll()
      .where("execution_id", "=", executionId)
      .where("step_id", "like", `${prefix}%`)
      .orderBy("step_id")
      .execute();

    return rows.map(parseStepResult);
  }

  /**
   * Recover stuck executions after a crash/restart.
   *
   * Resets all "running" executions back to "enqueued". Does NOT touch
   * step results — the orchestrator resolves incomplete results when it
   * re-claims the execution (using started_at_epoch_ms to distinguish
   * "never started" from "started executing").
   */
  async recoverStuckExecutions(): Promise<
    { id: string; organization_id: string }[]
  > {
    return this.db.transaction().execute(async (trx) => {
      const running = await trx
        .selectFrom("workflow_execution")
        .select(["id", "organization_id"])
        .where("status", "=", "running")
        .execute();

      if (running.length === 0) return [];

      const runningIds = running.map((r) => r.id);

      await trx
        .updateTable("workflow_execution")
        .set({ status: "enqueued", updated_at: Date.now() })
        .where("id", "in", runningIds)
        .where("status", "=", "running")
        .execute();

      return running;
    });
  }
}
