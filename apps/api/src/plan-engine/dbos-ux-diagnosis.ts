/**
 * The Plan page's store diagnosis as one durable DBOS workflow, with the
 * engine's step boundaries: a step that finished is not paid for again on
 * recovery, and a paid step is never retried on its own.
 *
 *   collect, capture, benchmark, probes, opportunities, hypotheses:<n>,
 *   repo-snapshot, verify-list, verify:<id>, data-checks, verify-fallen,
 *   reinvestigate:<rank>, fallen-note, retire:<rank>, replace:<rank>:<n>,
 *   drop:<rank>, reserves-note, outcomes, relevance, experiment-priority,
 *   review, outcomes-final, mockup-off, finish; `fail` on any failure.
 *
 * "Verify again" (PLAN_UX_HYPOTHESES_VERIFY) runs `phase: "verify"`, which
 * starts at verify-list. Step bodies live in run/; this file owns the
 * sequence, so the workflow source guard sees every change to it.
 */

import { DBOS, type StepConfig } from "@dbos-inc/dbos-sdk";
import { HYPOTHESES_BATCH, MAX_REPLACEMENT_TRIES } from "./opportunities.ts";
import {
  benchmarkStep,
  captureStep,
  collectStep,
  type FallenOpportunity,
  hypothesesStep,
  opportunitiesStep,
  probesStep,
} from "./run/diagnosis-steps.ts";
import {
  experimentPriorityStep,
  finishStep,
  mockupOffStep,
  relevanceStep,
  reviewStep,
} from "./run/dossier-steps.ts";
import { type EngineRun, openRun } from "./run/engine-run.ts";
import {
  type DroppedHypothesis,
  dataChecksStep,
  dropStep,
  failStep,
  fallenLines,
  limitsStep,
  outcomesStep,
  reinvestigateStep,
  replaceStep,
  repoSnapshotStep,
  reservesLines,
  retireStep,
  verifyFallenStep,
  verifyListStep,
  verifyStep,
} from "./run/verify-steps.ts";
import type { OpportunityDraft } from "./types.ts";

export interface UxDiagnosisRunInput {
  diagnosisId: string;
  orgId: string;
  /** The member who started it: the run reads and spends as them. */
  userId: string;
  /** "verify" = verify an existing diagnosis again. Absent = a full run. */
  phase?: "verify";
  /** "verify": only these hypotheses. */
  only?: string[];
  /** "verify": tags this round's spend so it does not collide with the first's. */
  runTag?: string;
  /** "verify": what the diagnosis had already spent. */
  priorCost?: number;
}

/** Paid steps are never retried on their own: a retry would bill the model again. */
const WORK_STEP: StepConfig = {
  retriesAllowed: false,
  timeoutMS: 15 * 60_000,
};

const WRITE_STEP: StepConfig = {
  retriesAllowed: true,
  maxAttempts: 3,
  intervalSeconds: 10,
  backoffRate: 1,
  timeoutMS: 2 * 60_000,
};

async function planUxDiagnosisWorkflowFn(
  input: UxDiagnosisRunInput,
): Promise<void> {
  const step = <T>(
    name: string,
    config: StepConfig,
    body: (run: EngineRun) => Promise<T>,
  ): Promise<T> =>
    DBOS.runStep(async () => body(await openRun(input)), { name, ...config });
  // Spend rows are `<scope>:c<n>`: a "verify again" tags its scopes.
  const costScope = (scope: string) =>
    input.runTag ? `${scope}:${input.runTag}` : scope;

  try {
    let priorCost = input.priorCost ?? 0;
    let reserves: OpportunityDraft[] = [];
    const prior: FallenOpportunity[] = [];

    if (input.phase !== "verify") {
      const collected = await step("collect", WORK_STEP, collectStep);
      const captureCost = await step("capture", WORK_STEP, captureStep);
      const benchmarkCost = await step("benchmark", WORK_STEP, benchmarkStep);
      await step("probes", WORK_STEP, probesStep);
      const opp = await step("opportunities", WORK_STEP, opportunitiesStep);
      const batches: string[][] = [];
      for (let i = 0; i < opp.ids.length; i += HYPOTHESES_BATCH) {
        batches.push(opp.ids.slice(i, i + HYPOTHESES_BATCH));
      }
      let hypothesesCost = 0;
      for (const [index, batch] of batches.entries()) {
        const out = await step(`hypotheses:${index + 1}`, WORK_STEP, (run) =>
          hypothesesStep(run, batch, index, batches.length),
        );
        hypothesesCost += out.cost;
        prior.push(...out.fallen);
      }
      reserves = opp.reserves;
      priorCost =
        collected.cost +
        captureCost +
        benchmarkCost +
        opp.cost +
        hypothesesCost;
      await step("repo-snapshot", WORK_STEP, repoSnapshotStep);
    }

    const verifyIds = await step("verify-list", WRITE_STEP, (run) =>
      verifyListStep(run, input.only),
    );
    let verifyCost = 0;
    const dropped: DroppedHypothesis[] = [];
    for (const [index, hypothesisId] of verifyIds.entries()) {
      const out = await step(`verify:${hypothesisId}`, WORK_STEP, (run) =>
        verifyStep(run, hypothesisId, index, verifyIds.length, costScope),
      );
      verifyCost += out.cost;
      if (out.dropped) dropped.push(out.dropped);
    }
    dropped.push(
      ...(await step("data-checks", WRITE_STEP, (run) =>
        dataChecksStep(run, input.only),
      )),
    );
    const fellInVerify = await step("verify-fallen", WRITE_STEP, (run) =>
      verifyFallenStep(run, prior, dropped),
    );
    // The same loss, another cause: what verification saw comes back as facts.
    let reinvestigateCost = 0;
    const stillFallen: FallenOpportunity[] = [];
    for (const f of fellInVerify) {
      const out = await step(`reinvestigate:${f.rank}`, WORK_STEP, (run) =>
        reinvestigateStep(run, f, costScope),
      );
      reinvestigateCost += out.cost;
      if (!out.found)
        stillFallen.push({ ...f, reason: out.reason ?? f.reason });
    }
    await step("fallen-note", WRITE_STEP, (run) =>
      limitsStep(run, fallenLines(stillFallen)),
    );
    // An opportunity with nothing standing leaves; a reserve tries its place.
    const fallen = [...prior, ...stillFallen].sort((a, b) => a.rank - b.rank);
    for (const f of fallen) {
      await step(`retire:${f.rank}`, WRITE_STEP, (run) => retireStep(run, f));
    }
    let replaceCost = 0;
    let nextReserve = 0;
    for (const f of fallen) {
      let filled = false;
      for (
        let attempt = 1;
        attempt <= MAX_REPLACEMENT_TRIES &&
        !filled &&
        nextReserve < reserves.length;
        attempt++
      ) {
        const next = reserves[nextReserve++];
        if (!next) break;
        const reserve = { ...next, rank: f.rank };
        const out = await step(
          `replace:${f.rank}:${attempt}`,
          WORK_STEP,
          (run) => replaceStep(run, f, reserve, attempt, costScope),
        );
        replaceCost += out.cost;
        filled = out.filled;
      }
      if (!filled) {
        await step(`drop:${f.rank}`, WRITE_STEP, (run) => dropStep(run, f));
      }
    }
    await step("reserves-note", WRITE_STEP, (run) =>
      limitsStep(run, reservesLines(reserves.slice(nextReserve))),
    );
    await step("outcomes", WRITE_STEP, outcomesStep);

    const relevanceCost = await step("relevance", WRITE_STEP, relevanceStep);
    await step("experiment-priority", WRITE_STEP, experimentPriorityStep);
    const reviewCost = await step("review", WORK_STEP, (run) =>
      reviewStep(run, costScope),
    );
    // Relevance and the review can change why an opportunity stopped.
    await step("outcomes-final", WRITE_STEP, outcomesStep);
    await step("mockup-off", WRITE_STEP, mockupOffStep);
    await step("finish", WRITE_STEP, (run) =>
      finishStep(
        run,
        priorCost +
          verifyCost +
          reinvestigateCost +
          replaceCost +
          relevanceCost +
          reviewCost,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[plan-engine] [${input.diagnosisId}] failed: ${message}`);
    await step("fail", WRITE_STEP, (run) =>
      failStep(run, input.runTag !== undefined, message),
    );
    throw err;
  }
}

let registeredWorkflow: typeof planUxDiagnosisWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(); guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerPlanUxDiagnosisWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(planUxDiagnosisWorkflowFn, {
    name: "planUxDiagnosisWorkflow",
  });
}

/** One workflow per diagnosis (and per "verify again" tag): a repeat start adopts it. */
const workflowIdOf = (input: UxDiagnosisRunInput) =>
  input.runTag
    ? `plan-ux-diagnosis:${input.diagnosisId}:${input.runTag}`
    : `plan-ux-diagnosis:${input.diagnosisId}`;

export async function startUxDiagnosisWorkflow(
  input: UxDiagnosisRunInput,
): Promise<string> {
  if (!registeredWorkflow) {
    throw new Error("planUxDiagnosisWorkflow is not registered");
  }
  const workflowID = workflowIdOf(input);
  await DBOS.startWorkflow(registeredWorkflow, { workflowID })(input);
  return workflowID;
}
