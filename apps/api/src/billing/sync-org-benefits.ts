/**
 * Durable org-benefit sync: paid-seat count → AI-gateway monthly allowance
 * (paid_seats × seatAllowanceCents, $5 default).
 *
 * Delivery guarantee is two-layered, and neither layer is in-memory:
 *  1. INTENT commits with the seat change — setSeats/releaseSeat write
 *     `benefits_reference_id` in the same transaction (a crash after commit
 *     can never lose it).
 *  2. DELIVERY is a DBOS workflow (step retries survive restarts) enqueued on
 *     the fast path, plus a scheduled sweep that re-enqueues rows whose
 *     marker stayed pending (pod died before enqueue, gateway down past the
 *     step-retry budget).
 *
 * The grant is ABSOLUTE (full current amount, not a delta) and idempotent at
 * the gateway per referenceId — so duplicate deliveries of the same reference
 * are no-ops, and only the LATEST change-set ever needs delivering (a newer
 * seat change overwrites the pending marker; superseded workflows exit
 * early). The gateway REBASES per grant — a mid-cycle seat change refreshes
 * the cycle's allowance, the plan's accepted slack.
 *
 * Second benefit — the weekly report run: the workflow converges the reports
 * service onto the org's choice (included_report_url) whenever the effective
 * seat count allows it (≥ 1), disarming the previously-armed site on a
 * choice change (armed_report_url tracks what's live over there).
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import { getDb } from "@/database";
import { getSettings } from "../settings";
import { OrganizationBillingStorage } from "../storage/organization-billing";
import { gatewayAdminConfigured, postGatewayAdmin } from "./gateway-admin";
import {
  isPermanentReportsFailure,
  reportsClientConfigured,
  setReportSchedule,
} from "./reports-client";
import { subscriptionInGoodStanding } from "./subscription-state";

const MICROS_PER_CENT = 10_000;
/** Fast path is instant; anything pending past this is a failed delivery. */
const SWEEP_STALE_AFTER_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 50;
const SWEEP_CRONTAB = "*/10 * * * *";

export function computeAllowanceMicros(
  paidSeatCount: number,
  seatAllowanceCents: number,
): number {
  return paidSeatCount * seatAllowanceCents * MICROS_PER_CENT;
}

/**
 * self_serve orgs grant 0 while the subscription isn't in good standing
 * (canceled/none — past_due is grace): seats describe WHO is paid-for, the
 * subscription is whether anyone is paying at all (subscriptionInGoodStanding
 * — the same predicate the middleware seat gate uses).
 */
export function effectivePaidSeatCount(
  billing: { billingMode: string; status: string } | null,
  paidSeatCount: number,
): number {
  return subscriptionInGoodStanding(billing) ? paidSeatCount : 0;
}

/** Whether ANY benefit is deliverable on this deployment — the gate for
 *  marking a change pending (a marker no workflow can ever clear is a
 *  permanently "stale" sweep row). Each workflow step re-checks its own
 *  benefit's config and skips independently. */
export function anyBenefitDeliverable(): boolean {
  return gatewayAdminConfigured() || reportsClientConfigured();
}

function storage(): OrganizationBillingStorage {
  return new OrganizationBillingStorage(getDb().db);
}

async function grantAllowance(
  organizationId: string,
  paidSeatCount: number,
  referenceId: string,
): Promise<void> {
  await postGatewayAdmin(
    "/api/admin/allowance",
    {
      orgId: organizationId,
      amountMicros: computeAllowanceMicros(
        paidSeatCount,
        getSettings().seatAllowanceCents,
      ),
      referenceId,
    },
    "gateway allowance grant",
  );
}

/**
 * Pure decision for the weekly-run convergence: what to disarm/arm to move
 * the reports service from `armedReportUrl` to the org's effective choice.
 * Disarm-then-arm ordering is load-bearing — a choice change (A → B) must
 * never leak A's weekly billed run.
 */
export function planReportScheduleSync(state: {
  paidSeatCount: number;
  includedReportUrl: string | null;
  armedReportUrl: string | null;
}): { desired: string | null; disarm: string | null; arm: string | null } {
  const desired = state.paidSeatCount >= 1 ? state.includedReportUrl : null;
  if (desired === state.armedReportUrl) {
    return { desired, disarm: null, arm: null };
  }
  return { desired, disarm: state.armedReportUrl, arm: desired };
}

/** Injectable seams for executeReportScheduleSync — production defaults are
 *  the real storage/client; integration tests swap `schedule` for a
 *  recording/failing fake while keeping the REAL Postgres storage. */
export interface ReportScheduleSyncDeps {
  storage: () => OrganizationBillingStorage;
  schedule: typeof setReportSchedule;
  configured: () => boolean;
}

/**
 * The syncReportSchedule step body (extracted so the execution path — the
 * load-bearing disarm-then-arm ordering, the permanent-4xx handling, the
 * in-step pending-ref re-check — is testable without DBOS).
 */
export async function executeReportScheduleSync(
  organizationId: string,
  referenceId: string,
  deps: ReportScheduleSyncDeps = {
    storage,
    schedule: setReportSchedule,
    configured: reportsClientConfigured,
  },
): Promise<void> {
  if (!deps.configured()) return;
  const s = deps.storage();
  const [billing, paidSeatUserIds] = await Promise.all([
    s.getBilling(organizationId),
    s.listPaidSeatUserIds(organizationId),
  ]);
  if ((billing?.benefitsReferenceId ?? null) !== referenceId) return;
  const plan = planReportScheduleSync({
    paidSeatCount: effectivePaidSeatCount(billing, paidSeatUserIds.length),
    includedReportUrl: billing?.includedReportUrl ?? null,
    armedReportUrl: billing?.armedReportUrl ?? null,
  });
  if (!plan.disarm && !plan.arm) return;
  // 4xx from the reports service is permanent (host unknown/unowned) —
  // retrying would poison this workflow AND every future delivery that
  // shares the pending marker. Disarm: the schedule is already gone over
  // there, proceed. Arm: log loudly, record nothing armed, and let the
  // next choice change re-attempt.
  if (plan.disarm) {
    try {
      await deps.schedule({
        host: plan.disarm,
        organizationId,
        enabled: false,
      });
    } catch (err) {
      if (!isPermanentReportsFailure(err)) throw err;
      console.error(
        "reports disarm permanently rejected (treating as disarmed):",
        { organizationId, host: plan.disarm, err: String(err) },
      );
    }
  }
  if (plan.arm) {
    try {
      await deps.schedule({ host: plan.arm, organizationId, enabled: true });
    } catch (err) {
      if (!isPermanentReportsFailure(err)) throw err;
      console.error(
        "reports arm permanently rejected — weekly run NOT armed:",
        {
          organizationId,
          host: plan.arm,
          err: String(err),
        },
      );
      await s.setArmedReportUrl(organizationId, null);
      return;
    }
  }
  await s.setArmedReportUrl(organizationId, plan.desired);
}

async function syncOrgBenefitsWorkflowFn(
  organizationId: string,
  referenceId: string,
): Promise<{ delivered: boolean }> {
  // Read live state: the CURRENT pending ref and the EFFECTIVE paid count
  // (effectivePaidSeatCount — subscription standing gates self_serve orgs).
  // If a newer seat change replaced the ref, that change's own workflow owns
  // delivery — exit.
  const state = await DBOS.runStep(
    async () => {
      const s = storage();
      const [billing, paidSeatUserIds] = await Promise.all([
        s.getBilling(organizationId),
        s.listPaidSeatUserIds(organizationId),
      ]);
      return {
        pendingRef: billing?.benefitsReferenceId ?? null,
        paidSeatCount: effectivePaidSeatCount(billing, paidSeatUserIds.length),
      };
    },
    { name: "readSeatState", retriesAllowed: true, maxAttempts: 3 },
  );
  if (state.pendingRef !== referenceId) return { delivered: false };

  await DBOS.runStep(
    async () => {
      if (!gatewayAdminConfigured()) return;
      await grantAllowance(organizationId, state.paidSeatCount, referenceId);
    },
    // Generous budget: the grant is gateway-idempotent per referenceId, and
    // this is money owed to the customer — outlast a gateway deploy window.
    { name: "grantAllowance", retriesAllowed: true, maxAttempts: 8 },
  );

  // Weekly-run benefit: converge the reports service onto the org's choice.
  // State is re-read INSIDE the step: the workflow-start snapshot can be
  // minutes stale (grantAllowance's retry budget, crash recovery replaying
  // checkpointed output), and acting on it can arm a superseded choice with
  // no pending marker left to correct it. In-step reads re-execute on every
  // retry/recovery, and the pending-ref re-check hands off to the newer
  // change's workflow. (A sub-second interleaving between this read and the
  // arm call remains possible; the next delivery converges it.)
  await DBOS.runStep(
    () => executeReportScheduleSync(organizationId, referenceId),
    { name: "syncReportSchedule", retriesAllowed: true, maxAttempts: 5 },
  );

  await DBOS.runStep(
    () => storage().clearBenefitsPending(organizationId, referenceId),
    { name: "clearPending", retriesAllowed: true, maxAttempts: 3 },
  );

  return { delivered: true };
}

/** Sweep: re-enqueue deliveries whose pending marker went stale. */
async function benefitsSyncSweepFn(): Promise<void> {
  if (!anyBenefitDeliverable()) return;
  const pending = await DBOS.runStep(
    () =>
      storage().listBenefitsPending(
        new Date(Date.now() - SWEEP_STALE_AFTER_MS),
        SWEEP_BATCH,
      ),
    { name: "listPending", retriesAllowed: true, maxAttempts: 3 },
  );
  // startWorkflow is forbidden inside a step — enqueue at workflow level.
  for (const row of pending) {
    await enqueueBenefitsSync(row.organizationId, row.referenceId, "sweep");
  }
}

let syncWorkflow: typeof syncOrgBenefitsWorkflowFn | null = null;

// Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
export function registerBenefitsSyncWorkflows(): void {
  if (syncWorkflow) return;
  // ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE requires bumping
  // DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
  syncWorkflow = DBOS.registerWorkflow(syncOrgBenefitsWorkflowFn, {
    name: "syncOrgBenefitsWorkflow",
  });
  const sweep = DBOS.registerWorkflow(benefitsSyncSweepFn, {
    name: "benefitsSyncSweep",
  });
  DBOS.registerScheduled(sweep, {
    name: "benefitsSyncSweep",
    crontab: SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}

/**
 * Enqueue a delivery (fast path after a seat change, or the sweep retry).
 * Fire-and-forget: the intent marker is already committed, so failure to
 * enqueue is exactly what the sweep exists for. workflowIDs are
 * per-origin/per-time-bucket rather than strictly unique — duplicate
 * deliveries are harmless (gateway referenceId dedupe), while a FAILED
 * fast-path workflow must not pin the ID forever (the sweep's bucketed ID
 * gets a fresh run).
 */
export async function enqueueBenefitsSync(
  organizationId: string,
  referenceId: string,
  origin: "apply" | "sweep",
): Promise<void> {
  if (!syncWorkflow) throw new Error("benefits sync workflow not registered");
  const bucket =
    origin === "sweep"
      ? `:${Math.floor(Date.now() / SWEEP_STALE_AFTER_MS)}`
      : "";
  await DBOS.startWorkflow(syncWorkflow, {
    workflowID: `benefits:${referenceId}:${origin}${bucket}`,
  })(organizationId, referenceId);
}
