import {
  validateNoCycles,
  type Step,
  type StepCondition,
} from "@decocms/bindings/workflow";
import { exponentialBackoffWithJitter } from "@decocms/std";
import type {
  WorkflowExecutionStorage,
  ParsedStepResult,
  ContextStepResult,
} from "../storage/workflow-execution";
import {
  extractRefs,
  parseAtRef,
  resolveAllRefs,
  resolveRef,
} from "./ref-resolver";
import { executeCode } from "./code-step";
import { executeToolStep, type ToolStepContext } from "./tool-step";

type StepType = "tool" | "code";

function getStepType(step: Step): StepType {
  if ("toolName" in step.action) return "tool";
  if ("code" in step.action) return "code";
  throw new Error(`Unknown step type for step: ${step.name}`);
}

type OnError = "fail" | "continue";

export type PublishEventFn = (
  type: string,
  subject: string,
  data?: Record<string, unknown>,
  options?: { deliverAt?: string },
) => Promise<void>;

export interface OrchestratorContext {
  storage: WorkflowExecutionStorage;
  publish: PublishEventFn;
  createMCPProxy: ToolStepContext["createMCPProxy"];
}

function log(eid: string, msg: string) {
  console.log(`[WF:orch] ${eid} ${msg}`);
}

const MAX_RETRY_BACKOFF_MS = 300_000; // 5 minutes

function computeRetryBackoffMs(
  backoffMs: number,
  attemptNumber: number,
): number {
  // Exponential backoff + cap via the shared primitive, plus a small additive
  // 0–1000ms jitter (kept additive here, unlike the primitive's multiplicative
  // jitter, to preserve the prior retry-timing distribution).
  const base = exponentialBackoffWithJitter(
    MAX_RETRY_BACKOFF_MS,
    backoffMs,
    attemptNumber - 1,
    2,
    0,
  );
  return Math.min(base + Math.random() * 1000, MAX_RETRY_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

function getStepDependencies(step: Step): string[] {
  const refs = extractRefs(step.input);

  if (step.forEach?.ref) {
    refs.push(step.forEach.ref);
  }

  // Include bail condition ref as a dependency
  if (step.bail && step.bail !== true) {
    refs.push(step.bail.ref);
  }

  const deps = new Set<string>();
  for (const ref of refs) {
    if (ref.startsWith("@")) {
      const parsed = parseAtRef(ref as `@${string}`);
      if (
        parsed.type === "step" &&
        parsed.stepName &&
        parsed.stepName !== step.name
      ) {
        deps.add(parsed.stepName);
      }
    }
  }

  return Array.from(deps);
}

function isForEachStep(step: Step): boolean {
  return !!step.forEach?.ref;
}

function iterationIndex(stepId: string): number {
  const match = stepId.match(/\[(\d+)\]$/);
  return match ? Number(match[1]) : -1;
}

/**
 * Build the output array for a completed forEach step.
 * Sorts by numeric iteration index so the output array preserves positional
 * correspondence with the input array (index 0 → slot 0, etc.).
 * Failed iterations get `null` so downstream steps can correlate by position.
 */
function buildForEachOutput(
  iterationResults: ContextStepResult[],
  totalIterations: number,
): unknown[] {
  const output: unknown[] = new Array(totalIterations).fill(null);
  for (const r of iterationResults) {
    const idx = iterationIndex(r.step_id);
    if (idx >= 0 && idx < totalIterations && r.completed_at_epoch_ms) {
      output[idx] = r.error ? null : r.output;
    }
  }
  return output;
}

function getTerminalSteps(steps: Step[]): Step[] {
  const allDeps = new Set(steps.flatMap(getStepDependencies));
  return steps.filter((s) => !allDeps.has(s.name));
}

function buildWorkflowOutput(
  steps: Step[],
  stepOutputs: Map<string, unknown>,
): unknown {
  const terminalSteps = getTerminalSteps(steps);
  if (terminalSteps.length === 1 && terminalSteps[0]) {
    return stepOutputs.get(terminalSteps[0].name);
  }
  const output: Record<string, unknown> = {};
  for (const step of terminalSteps) {
    output[step.name] = stepOutputs.get(step.name);
  }
  return output;
}

function getReadySteps(
  steps: Step[],
  completedStepNames: Set<string>,
  claimedStepNames: Set<string>,
): Step[] {
  return steps.filter((step) => {
    if (completedStepNames.has(step.name) || claimedStepNames.has(step.name)) {
      return false;
    }
    const deps = getStepDependencies(step);
    return deps.every((dep) => completedStepNames.has(dep));
  });
}

// ---------------------------------------------------------------------------
// Condition evaluation (shared by `when` and `bail`)
// ---------------------------------------------------------------------------

function evaluateCondition(
  condition: true | StepCondition,
  stepOutputs: Map<string, unknown>,
  workflowInput: Record<string, unknown>,
  executionId: string,
): boolean {
  if (condition === true) return true;

  const ref = condition.ref;
  if (!ref.startsWith("@")) return false;

  const { value } = resolveRef(ref as `@${string}`, {
    stepOutputs,
    workflowInput,
    executionId,
  });

  const hasOperator =
    condition.eq !== undefined ||
    condition.neq !== undefined ||
    condition.gt !== undefined ||
    condition.lt !== undefined;

  // No operator → truthy check
  if (!hasOperator) return !!value;

  if (condition.eq !== undefined && value !== condition.eq) return false;
  if (condition.neq !== undefined && value === condition.neq) return false;
  if (
    condition.gt !== undefined &&
    (typeof value !== "number" || value <= condition.gt)
  )
    return false;
  if (
    condition.lt !== undefined &&
    (typeof value !== "number" || value >= condition.lt)
  )
    return false;

  return true;
}

// ---------------------------------------------------------------------------
// Orchestration set builders
// ---------------------------------------------------------------------------

function buildStepOutputsMap(
  stepResults: ContextStepResult[],
): Map<string, unknown> {
  const stepOutputs = new Map<string, unknown>();
  for (const result of stepResults) {
    if (result.completed_at_epoch_ms) {
      stepOutputs.set(result.step_id, result.output);
    }
  }
  return stepOutputs;
}

function buildOrchestrationSets(stepResults: ContextStepResult[]): {
  completedStepNames: Set<string>;
  claimedStepNames: Set<string>;
  stepOutputs: Map<string, unknown>;
} {
  const completedStepNames = new Set<string>();
  const claimedStepNames = new Set<string>();
  const stepOutputs = new Map<string, unknown>();

  for (const result of stepResults) {
    if (result.step_id.includes("[")) continue;

    if (result.completed_at_epoch_ms) {
      completedStepNames.add(result.step_id);
      stepOutputs.set(result.step_id, result.output);
    } else {
      claimedStepNames.add(result.step_id);
    }
  }

  return { completedStepNames, claimedStepNames, stepOutputs };
}

// ---------------------------------------------------------------------------
// advanceExecution — shared "check completion → dispatch ready" logic
// ---------------------------------------------------------------------------

async function advanceExecution(
  ctx: OrchestratorContext,
  executionId: string,
  prefetchedContext?: Awaited<
    ReturnType<WorkflowExecutionStorage["getExecutionContext"]>
  >,
): Promise<void> {
  const eid = executionId.slice(0, 8);
  const context =
    prefetchedContext ?? (await ctx.storage.getExecutionContext(executionId));
  if (!context || context.execution.status !== "running") return;

  const steps = context.workflow.steps;
  const workflowInput = context.workflow.input ?? {};

  const deadlineAtEpochMs = context.execution.deadline_at_epoch_ms;
  if (deadlineAtEpochMs && Date.now() >= deadlineAtEpochMs) {
    log(eid, "deadline exceeded, failing");
    await ctx.storage.updateExecution(
      executionId,
      {
        status: "error",
        error: "Workflow execution exceeded its deadline",
        completed_at_epoch_ms: Date.now(),
      },
      { onlyIfStatus: "running" },
    );
    return;
  }

  const { completedStepNames, claimedStepNames, stepOutputs } =
    buildOrchestrationSets(context.stepResults);

  // Check for unhandled step errors (can occur after crash recovery resolution,
  // where resolveIncompleteStepResults marks tool steps as errored without
  // going through the normal handleStepCompleted → handleStepError flow)
  for (const result of context.stepResults) {
    if (!result.error || !result.completed_at_epoch_ms) continue;
    if (result.step_id.includes("[")) continue;
    const step = steps.find((s) => s.name === result.step_id);
    const onError: OnError = step?.config?.onError ?? "fail";
    if (onError === "fail") {
      log(eid, `step "${result.step_id}" has unhandled error, failing`);
      await ctx.storage.updateExecution(
        executionId,
        {
          status: "error",
          error: `Step "${result.step_id}" failed: ${String(result.error)}`,
          completed_at_epoch_ms: Date.now(),
        },
        { onlyIfStatus: "running" },
      );
      return;
    }
  }

  if (completedStepNames.size === steps.length) {
    log(eid, "all steps done, marking success");
    await ctx.storage.updateExecution(
      executionId,
      {
        status: "success",
        output: buildWorkflowOutput(steps, stepOutputs),
        completed_at_epoch_ms: Date.now(),
      },
      { onlyIfStatus: "running" },
    );
    return;
  }

  const readySteps = getReadySteps(steps, completedStepNames, claimedStepNames);
  if (readySteps.length === 0) return;

  log(eid, `dispatching ${readySteps.length} ready step(s)`);
  await Promise.all(
    readySteps.map((step) =>
      dispatchStep(ctx, executionId, step, workflowInput, stepOutputs).catch(
        (error: Error) => {
          console.error(
            `[WF:orch] Failed to dispatch step ${executionId}/${step.name}:`,
            error,
          );
        },
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Recovery resolution — resolve incomplete step results from prior crash
// ---------------------------------------------------------------------------

async function resolveIncompleteStepResults(
  ctx: OrchestratorContext,
  executionId: string,
  steps: Step[],
  existingResults: ParsedStepResult[],
): Promise<void> {
  const eid = executionId.slice(0, 8);
  const stepsByName = new Map(steps.map((s) => [s.name, s]));

  for (const result of existingResults) {
    if (result.completed_at_epoch_ms) continue;

    const baseName = result.step_id.replace(/\[\d+\]$/, "");
    const step = stepsByName.get(baseName);

    await resolveOneIncompleteResult(
      ctx,
      executionId,
      eid,
      result,
      baseName,
      step,
    );
  }
}

async function resolveOneIncompleteResult(
  ctx: OrchestratorContext,
  executionId: string,
  eid: string,
  result: ParsedStepResult,
  baseName: string,
  step: Step | undefined,
): Promise<void> {
  const neverStarted = result.started_at_epoch_ms === null;
  const isPendingRetry = neverStarted && (result.attempt_number ?? 1) > 1;

  if (isPendingRetry) {
    const iterMatch = result.step_id.match(/\[(\d+)\]$/);
    const backoffMs = step?.config?.backoffMs ?? 1_000;
    const delay = computeRetryBackoffMs(backoffMs, result.attempt_number ?? 1);
    await ctx.publish(
      "workflow.step.execute",
      executionId,
      {
        stepName: baseName,
        iterationIndex: iterMatch ? Number(iterMatch[1]) : undefined,
      },
      { deliverAt: new Date(Date.now() + delay).toISOString() },
    );
    return;
  }

  if (neverStarted) {
    await ctx.storage.deleteStepResult(executionId, result.step_id);
    return;
  }

  const isCodeStep = step && getStepType(step) === "code";
  if (isCodeStep) {
    log(eid, `recovery: deleting interrupted code step ${result.step_id}`);
    await ctx.storage.deleteStepResult(executionId, result.step_id);
    return;
  }

  log(
    eid,
    `recovery: marking interrupted tool step ${result.step_id} as error`,
  );
  await ctx.storage.updateStepResult(executionId, result.step_id, {
    error: "Step interrupted by process restart",
    completed_at_epoch_ms: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

export async function handleExecutionCreated(
  ctx: OrchestratorContext,
  executionId: string,
): Promise<void> {
  const eid = executionId.slice(0, 8);
  log(eid, "executionCreated — claiming");

  const claimed = await ctx.storage.claimExecution(executionId);
  if (!claimed) {
    log(eid, "executionCreated — already claimed, skipping");
    return;
  }

  const { execution, workflow } = claimed;
  const steps = workflow.steps;

  const deadlineAtEpochMs = execution.deadline_at_epoch_ms;
  if (deadlineAtEpochMs && Date.now() >= deadlineAtEpochMs) {
    log(eid, "executionCreated — deadline already passed, failing");
    await ctx.storage.updateExecution(executionId, {
      status: "error",
      error: "Workflow execution exceeded its deadline",
      completed_at_epoch_ms: Date.now(),
    });
    return;
  }

  if (!steps?.length) {
    await ctx.storage.updateExecution(executionId, {
      status: "error",
      error: "Workflow has no steps",
      completed_at_epoch_ms: Date.now(),
    });
    return;
  }

  const validation = validateNoCycles(steps);
  if (!validation.isValid) {
    await ctx.storage.updateExecution(executionId, {
      status: "error",
      error: validation.error,
      completed_at_epoch_ms: Date.now(),
    });
    return;
  }

  // Resolve incomplete step results from a prior crash
  const existingResults = await ctx.storage.getStepResults(executionId);
  if (existingResults.some((r) => !r.completed_at_epoch_ms)) {
    await resolveIncompleteStepResults(
      ctx,
      executionId,
      steps,
      existingResults,
    );
  }

  await advanceExecution(ctx, executionId);
  log(eid, "executionCreated — done");
}

/**
 * Handle workflow.step.execute event.
 * Claims the step, executes it, persists the result, publishes step.completed.
 */
export async function handleStepExecute(
  ctx: OrchestratorContext,
  executionId: string,
  stepName: string,
  iterationIndex?: number,
): Promise<void> {
  const isIteration = iterationIndex !== undefined;
  const stepId = isIteration ? `${stepName}[${iterationIndex}]` : stepName;
  const eid = executionId.slice(0, 8);

  const context = await ctx.storage.getExecutionContext(executionId);
  if (!context || context.execution.status !== "running") {
    log(eid, `stepExecute ${stepId} — execution not running, skipping`);
    return;
  }

  // Guard: if the workflow deadline has passed, fail the execution instead of
  // executing the step. This catches retry events delivered after deadline.
  const deadlineAtEpochMs = context.execution.deadline_at_epoch_ms;
  if (deadlineAtEpochMs && Date.now() >= deadlineAtEpochMs) {
    log(eid, `stepExecute ${stepId} — deadline exceeded, failing execution`);
    await ctx.storage.updateExecution(
      executionId,
      {
        status: "error",
        error: "Workflow execution exceeded its deadline",
        completed_at_epoch_ms: Date.now(),
      },
      { onlyIfStatus: "running" },
    );
    return;
  }

  const steps = context.workflow.steps;
  const step = steps.find((s) => s.name === stepName);
  if (!step) {
    log(eid, `stepExecute ${stepId} — step not found`);
    return;
  }

  // Check if this is a retry (row exists with attempt_number > 1, not yet started)
  const existingResult = context.stepResults.find((r) => r.step_id === stepId);
  const isRetry =
    existingResult &&
    (existingResult.attempt_number ?? 1) > 1 &&
    !existingResult.started_at_epoch_ms;

  let claimed: ParsedStepResult | null;
  if (isRetry) {
    claimed = await ctx.storage.claimStepForRetry(
      executionId,
      stepId,
      existingResult.attempt_number,
    );
  } else {
    claimed = await ctx.storage.createStepResult({
      execution_id: executionId,
      step_id: stepId,
    });
  }
  if (!claimed) {
    log(eid, `stepExecute ${stepId} — already claimed, skipping`);
    return;
  }

  // Resolve input
  const workflowInput = context.workflow.input ?? {};
  const stepOutputs = buildStepOutputsMap(context.stepResults);

  let resolvedInput: Record<string, unknown>;
  if (isIteration && step.forEach?.ref) {
    const { resolved: forEachResolved } = resolveAllRefs(
      { items: step.forEach.ref },
      { workflowInput, stepOutputs, executionId },
    );
    const items = (forEachResolved as { items: unknown[] }).items;
    const item = Array.isArray(items) ? items[iterationIndex] : undefined;

    const { resolved } = resolveAllRefs(step.input, {
      workflowInput,
      stepOutputs,
      item,
      index: iterationIndex,
      executionId,
    });
    resolvedInput = resolved as Record<string, unknown>;
  } else {
    const { resolved } = resolveAllRefs(step.input, {
      workflowInput,
      stepOutputs,
      executionId,
    });
    resolvedInput = resolved as Record<string, unknown>;
  }

  // Mark execution start time (distinguishes "claimed" from "executing" for crash recovery)
  const stepType = getStepType(step);
  await ctx.storage.updateStepResult(executionId, stepId, {
    started_at_epoch_ms: Date.now(),
  });

  let output: unknown;
  let error: string | undefined;

  log(eid, `stepExecute ${stepId} — running (${stepType})`);

  try {
    if (stepType === "tool") {
      const toolCtx: ToolStepContext = {
        virtualMcpId: context.workflow.virtual_mcp_id,
        createMCPProxy: ctx.createMCPProxy,
        storage: ctx.storage,
        executionId,
      };
      const result = await executeToolStep(toolCtx, step, resolvedInput);
      output = result.output;
      error = result.error;
    } else if (stepType === "code" && "code" in step.action) {
      const result = await executeCode(
        step.action.code,
        resolvedInput,
        stepId,
        step.config?.timeoutMs ?? 10_000,
      );
      output = result.output;
      error = result.error;
    } else {
      error = `Unknown step type for step ${stepName}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await ctx.storage.updateStepResult(executionId, stepId, {
    output,
    error,
    completed_at_epoch_ms: Date.now(),
  });
  await ctx.publish("workflow.step.completed", executionId, {
    stepName,
    iterationIndex,
  });

  log(eid, `stepExecute ${stepId} — done${error ? " (error)" : ""}`);
}

/**
 * Handle workflow.step.completed event.
 * The step result has already been persisted. This handler orchestrates next steps.
 */
export async function handleStepCompleted(
  ctx: OrchestratorContext,
  executionId: string,
  stepName: string,
  iterationIndex?: number,
): Promise<void> {
  const isIteration = iterationIndex !== undefined;
  const stepId = isIteration ? `${stepName}[${iterationIndex}]` : stepName;
  const eid = executionId.slice(0, 8);

  const context = await ctx.storage.getExecutionContext(executionId);
  if (!context) return;

  const steps = context.workflow.steps;
  const step = steps.find((s) => s.name === stepName);
  const stepResult = context.stepResults.find((r) => r.step_id === stepId);
  const error = stepResult?.error ? String(stepResult.error) : undefined;
  const isWorkflowRunning = context.execution.status === "running";
  const workflowInput = context.workflow.input ?? {};

  log(eid, `stepCompleted ${stepId}${error ? " (error)" : ""}`);

  if (error && isWorkflowRunning) {
    const retried = await tryRetryStep(
      ctx,
      executionId,
      stepId,
      stepName,
      step,
      stepResult?.attempt_number ?? 1,
      context.execution.deadline_at_epoch_ms,
      iterationIndex,
    );
    if (retried) return;

    const onError: OnError =
      step?.config?.onError ?? (isIteration ? "continue" : "fail");
    const shouldContinue = await handleStepError(
      ctx,
      executionId,
      stepId,
      error,
      isIteration,
      onError,
    );
    if (!shouldContinue) return;
  }

  if (isIteration) {
    if (!step?.forEach) return;
    await handleForEachIterationCompletion(
      ctx,
      executionId,
      stepName,
      step,
      context.stepResults,
      workflowInput,
      isWorkflowRunning,
    );
    return;
  }

  if (!isWorkflowRunning) return;

  if (!error && step) {
    const stepOutputs = buildStepOutputsMap(context.stepResults);
    const bailed = await tryBail(
      ctx,
      executionId,
      step,
      stepName,
      stepOutputs,
      workflowInput,
    );
    if (bailed) return;
  }

  await advanceExecution(ctx, executionId, context);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to schedule a retry for a failed step.
 * Returns true if a retry was scheduled, false if we should fall through to error handling.
 */
async function tryRetryStep(
  ctx: OrchestratorContext,
  executionId: string,
  stepId: string,
  stepName: string,
  step: Step | undefined,
  attemptNumber: number,
  deadlineEpochMs: number | null,
  iterationIndex?: number,
): Promise<boolean> {
  const maxAttempts = step?.config?.maxAttempts ?? 1;
  if (maxAttempts <= 1 || attemptNumber >= maxAttempts) return false;

  const backoffMs = step?.config?.backoffMs ?? 1_000;
  const retryDelay = computeRetryBackoffMs(backoffMs, attemptNumber);

  if (deadlineEpochMs && Date.now() + retryDelay > deadlineEpochMs) {
    return false;
  }

  await ctx.storage.resetStepResultForRetry(
    executionId,
    stepId,
    attemptNumber + 1,
  );
  await ctx.publish(
    "workflow.step.execute",
    executionId,
    { stepName, iterationIndex },
    { deliverAt: new Date(Date.now() + retryDelay).toISOString() },
  );
  return true;
}

/**
 * Evaluate bail condition and complete the workflow early if triggered.
 * Returns true if the workflow was bailed, false otherwise.
 */
async function tryBail(
  ctx: OrchestratorContext,
  executionId: string,
  step: Step,
  stepName: string,
  stepOutputs: Map<string, unknown>,
  workflowInput: Record<string, unknown>,
): Promise<boolean> {
  if (!step.bail) return false;

  const eid = executionId.slice(0, 8);
  const shouldBail = evaluateCondition(
    step.bail,
    stepOutputs,
    workflowInput,
    executionId,
  );
  if (!shouldBail) return false;

  const output = stepOutputs.get(stepName);
  log(eid, `bail triggered by step "${stepName}", exiting early`);
  await ctx.storage.updateExecution(
    executionId,
    {
      status: "success",
      output,
      completed_at_epoch_ms: Date.now(),
    },
    { onlyIfStatus: "running" },
  );
  return true;
}

async function handleStepError(
  ctx: OrchestratorContext,
  executionId: string,
  stepId: string,
  error: string,
  isIteration: boolean,
  onError: OnError,
): Promise<boolean> {
  if (onError === "continue") {
    return true;
  }

  await ctx.storage.updateExecution(
    executionId,
    {
      status: "error",
      error: `Step "${stepId}" failed: ${error}`,
      completed_at_epoch_ms: Date.now(),
    },
    { onlyIfStatus: "running" },
  );

  return isIteration;
}

async function handleForEachIterationCompletion(
  ctx: OrchestratorContext,
  executionId: string,
  stepName: string,
  step: Step,
  stepResults: ContextStepResult[],
  workflowInput: Record<string, unknown>,
  isWorkflowRunning: boolean,
): Promise<void> {
  const eid = executionId.slice(0, 8);
  const onError: OnError = step.config?.onError ?? "continue";
  const stepOutputs = buildStepOutputsMap(stepResults);

  const { resolved } = resolveAllRefs(
    { items: step.forEach!.ref },
    { workflowInput, stepOutputs, executionId },
  );
  const items = (resolved as { items: unknown[] }).items;

  if (!Array.isArray(items)) {
    console.error(
      `[WF:orch] forEach ref did not resolve to array: ${step.forEach!.ref}`,
    );
    return;
  }

  const totalIterations = items.length;

  const iterationResults = await ctx.storage.getStepResultsByPrefix(
    executionId,
    `${stepName}[`,
  );
  const completedIterations = iterationResults.filter(
    (r) => r.completed_at_epoch_ms,
  );
  const failedIterations = completedIterations.filter((r) => r.error);

  log(
    eid,
    `forEach ${stepName} — ${completedIterations.length}/${totalIterations} done`,
  );

  if (completedIterations.length === totalIterations) {
    const output = buildForEachOutput(iterationResults, totalIterations);
    const errors = failedIterations.map((r) => String(r.error));
    const parentError =
      onError === "fail" && errors.length > 0 ? errors.join(", ") : undefined;

    await ctx.storage.updateStepResult(executionId, stepName, {
      output,
      error: parentError,
      completed_at_epoch_ms: Date.now(),
    });

    if (isWorkflowRunning) {
      if (!parentError) {
        const updatedOutputs = new Map(stepOutputs);
        updatedOutputs.set(stepName, output);
        const bailed = await tryBail(
          ctx,
          executionId,
          step,
          stepName,
          updatedOutputs,
          workflowInput,
        );
        if (bailed) return;
      }
      await advanceExecution(ctx, executionId);
    }
    return;
  }

  // Dispatch next iterations to refill the concurrency window
  const concurrency = step.forEach!.concurrency ?? totalIterations;
  const inFlightCount = iterationResults.length - completedIterations.length;
  const nextIndex = iterationResults.length;
  const shouldContinue =
    isWorkflowRunning &&
    (onError === "continue" || failedIterations.length === 0);

  if (shouldContinue && inFlightCount < concurrency) {
    const slotsAvailable = concurrency - inFlightCount;
    const nextIndices: number[] = [];
    for (
      let i = nextIndex;
      i < totalIterations && nextIndices.length < slotsAvailable;
      i++
    ) {
      nextIndices.push(i);
    }
    if (nextIndices.length > 0) {
      log(
        eid,
        `forEach ${stepName} — dispatching ${nextIndices.length} more iteration(s)`,
      );
      await Promise.all(
        nextIndices.map((idx) =>
          ctx.publish("workflow.step.execute", executionId, {
            stepName,
            iterationIndex: idx,
          }),
        ),
      );
    }
  }
}

async function dispatchStep(
  ctx: OrchestratorContext,
  executionId: string,
  step: Step,
  workflowInput: Record<string, unknown>,
  stepOutputs: Map<string, unknown>,
): Promise<void> {
  const eid = executionId.slice(0, 8);

  if (isForEachStep(step)) {
    const { resolved } = resolveAllRefs(
      { items: step.forEach!.ref },
      { workflowInput, stepOutputs, executionId },
    );
    const items = (resolved as { items: unknown[] }).items;

    if (!Array.isArray(items)) {
      await ctx.storage.createStepResult({
        execution_id: executionId,
        step_id: step.name,
        error: `forEach ref did not resolve to array: ${step.forEach!.ref}`,
        completed_at_epoch_ms: Date.now(),
      });
      return;
    }

    if (items.length === 0) {
      await ctx.storage.createStepResult({
        execution_id: executionId,
        step_id: step.name,
        output: [],
        completed_at_epoch_ms: Date.now(),
      });
      return;
    }

    const parentClaimed = await ctx.storage.createStepResult({
      execution_id: executionId,
      step_id: step.name,
    });
    if (!parentClaimed) return;

    // Check for existing iteration results (recovery case)
    const existingIterations = await ctx.storage.getStepResultsByPrefix(
      executionId,
      `${step.name}[`,
    );
    const completedIterationIndices = new Set<number>();
    for (const r of existingIterations) {
      if (r.completed_at_epoch_ms) {
        const match = r.step_id.match(/\[(\d+)\]$/);
        if (match) completedIterationIndices.add(Number(match[1]));
      }
    }

    // All iterations already completed (crash between iteration completion and parent finalization)
    if (completedIterationIndices.size === items.length) {
      const output = buildForEachOutput(existingIterations, items.length);
      const errorResults = existingIterations
        .filter((r) => r.completed_at_epoch_ms && r.error)
        .map((r) => String(r.error));
      const parentError =
        errorResults.length > 0 ? errorResults.join(", ") : undefined;

      await ctx.storage.updateStepResult(executionId, step.name, {
        output,
        error: parentError,
        completed_at_epoch_ms: Date.now(),
      });

      await ctx.publish("workflow.step.completed", executionId, {
        stepName: step.name,
      });
      return;
    }

    const concurrency = step.forEach!.concurrency ?? items.length;
    const pendingIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (!completedIterationIndices.has(i)) {
        pendingIndices.push(i);
      }
    }

    const initialBatch = pendingIndices.slice(0, concurrency);
    log(
      eid,
      `dispatchStep ${step.name} — forEach: ${items.length} items, concurrency=${concurrency}, batch=${initialBatch.length}`,
    );

    await Promise.all(
      initialBatch.map((index) =>
        ctx.publish("workflow.step.execute", executionId, {
          stepName: step.name,
          iterationIndex: index,
        }),
      ),
    );
  } else {
    await ctx.publish("workflow.step.execute", executionId, {
      stepName: step.name,
    });
  }
}
