/**
 * Brand-context preset DBOS workflow.
 *
 * Wraps the `brand-context` preset lifecycle from click → completion. The
 * workflow's only job is to wait for the `brand-extracted` signal that the
 * `BRAND_CONTEXT_SETUP` tool emits when the LLM successfully calls it from
 * the seeded thread, then mark the preset task `completed`. If no signal
 * arrives within `BRAND_CONTEXT_RECV_TIMEOUT_SEC` (the user abandoned the
 * chat / Firecrawl never succeeded), the workflow marks the task `error`.
 *
 * Why DBOS instead of a plain promise: the workflow handle (`workflowID`)
 * survives mesh restarts. The tool handler — which may run on a different
 * pod from the one that started the workflow — just needs the ID to
 * `DBOS.send` the signal, and DBOS routes it to whichever worker is
 * currently awaiting it. No in-memory coordination, no lost completions on
 * deploy.
 *
 * Runtime deps (the preset task store) are wired via `setBrandContextWorkflowDeps`
 * during app boot, mirroring the `setAutomationRuntime` pattern in
 * `apps/mesh/src/automations/dbos-workflow.ts`.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { PresetTaskState, PresetTaskStore } from "@/storage/preset-tasks";

export const BRAND_CONTEXT_PRESET_ID = "brand-context";
export const BRAND_EXTRACTED_TOPIC = "brand-extracted";

/** 30 min. Long enough for an unhurried first-time setup conversation. */
const BRAND_CONTEXT_RECV_TIMEOUT_SEC = 30 * 60;

interface BrandExtractedSignal {
  brandId: string;
}

interface BrandContextWorkflowInput {
  organizationId: string;
  taskId: string;
}

type BrandContextWorkflowOutcome =
  | { ok: true; brandId: string }
  | { ok: false; reason: "timeout" };

interface BrandContextWorkflowDeps {
  presetTaskStore: PresetTaskStore;
}

let deps: BrandContextWorkflowDeps | null = null;

export function setBrandContextWorkflowDeps(d: BrandContextWorkflowDeps): void {
  deps = d;
}

function requireDeps(): BrandContextWorkflowDeps {
  if (!deps) {
    throw new Error(
      "[brand-context-workflow] deps not initialized — setBrandContextWorkflowDeps() must run before workflows fire",
    );
  }
  return deps;
}

async function markCompletedStep(
  organizationId: string,
  taskId: string,
  brandId: string,
): Promise<void> {
  const { presetTaskStore } = requireDeps();
  const prev = await presetTaskStore.get(
    organizationId,
    BRAND_CONTEXT_PRESET_ID,
  );
  // Stale-run guard: if the user kicked off a newer run, its `/start` already
  // bumped workflowRunId. Older workflows finishing late must not clobber it.
  if (prev?.workflowRunId !== taskId) {
    console.warn(
      `[brand-context-workflow] skipping completed write — stale run (prev.workflowRunId=${prev?.workflowRunId}, taskId=${taskId})`,
    );
    return;
  }
  const next: PresetTaskState = {
    ...prev,
    status: "completed",
    completedAt: new Date().toISOString(),
    workflowRunId: taskId,
    // brandId is recorded in steps[] for forensic value — the canonical
    // pointer is the brand_context row itself, looked up by org.
    steps: [
      ...(prev?.steps ?? []),
      {
        name: "brand-extracted",
        status: "done",
        completedAt: new Date().toISOString(),
      },
    ],
    error: undefined,
  };
  await presetTaskStore.set(organizationId, BRAND_CONTEXT_PRESET_ID, next);
  void brandId; // kept for trace context; future: persist if multi-brand support lands
}

async function markErrorStep(
  organizationId: string,
  taskId: string,
  error: string,
): Promise<void> {
  const { presetTaskStore } = requireDeps();
  const prev = await presetTaskStore.get(
    organizationId,
    BRAND_CONTEXT_PRESET_ID,
  );
  if (prev?.workflowRunId !== taskId) {
    console.warn(
      `[brand-context-workflow] skipping error write — stale run (prev.workflowRunId=${prev?.workflowRunId}, taskId=${taskId}, error=${error})`,
    );
    return;
  }
  const next: PresetTaskState = {
    ...prev,
    status: "error",
    workflowRunId: taskId,
    error,
  };
  await presetTaskStore.set(organizationId, BRAND_CONTEXT_PRESET_ID, next);
}

async function brandContextWorkflowFn(
  input: BrandContextWorkflowInput,
): Promise<BrandContextWorkflowOutcome> {
  const signal = await DBOS.recv<BrandExtractedSignal>(
    BRAND_EXTRACTED_TOPIC,
    BRAND_CONTEXT_RECV_TIMEOUT_SEC,
  );

  if (!signal) {
    await DBOS.runStep(
      () => markErrorStep(input.organizationId, input.taskId, "timeout"),
      { name: "markError" },
    );
    return { ok: false, reason: "timeout" };
  }

  await DBOS.runStep(
    () => markCompletedStep(input.organizationId, input.taskId, signal.brandId),
    { name: "markCompleted" },
  );
  return { ok: true, brandId: signal.brandId };
}

const brandContextWorkflow = DBOS.registerWorkflow(brandContextWorkflowFn, {
  name: "brandContextWorkflow",
});

/**
 * Start the workflow and return its handle. Caller is expected to persist
 * `handle.workflowID` on the preset task state so the `BRAND_CONTEXT_SETUP`
 * tool handler can locate it for `DBOS.send`.
 */
export async function startBrandContextWorkflow(
  input: BrandContextWorkflowInput,
) {
  return DBOS.startWorkflow(brandContextWorkflow)(input);
}
