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
 * TODO(billing/4.1): second benefit — reports weekly-run schedule for
 * included_report_url — joins the workflow once the reports endpoint exists.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import { getDb } from "@/database";
import { getSettings } from "../settings";
import { OrganizationBillingStorage } from "../storage/organization-billing";

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

/** Whether this deployment can deliver benefits at all (self-hosted can't). */
export function benefitsSyncEnabled(): boolean {
  const settings = getSettings();
  return settings.aiGatewayEnabled && !!settings.aiGatewayAdminToken;
}

function storage(): OrganizationBillingStorage {
  return new OrganizationBillingStorage(getDb().db);
}

async function grantAllowance(
  organizationId: string,
  paidSeatCount: number,
  referenceId: string,
): Promise<void> {
  const settings = getSettings();
  const res = await fetch(`${settings.aiGatewayUrl}/api/admin/allowance`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.aiGatewayAdminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      orgId: organizationId,
      amountMicros: computeAllowanceMicros(
        paidSeatCount,
        settings.seatAllowanceCents,
      ),
      referenceId,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gateway allowance grant failed (${res.status}): ${body}`);
  }
}

async function syncOrgBenefitsWorkflowFn(
  organizationId: string,
  referenceId: string,
): Promise<{ delivered: boolean }> {
  // Read live state: the CURRENT pending ref and the EFFECTIVE paid count.
  // If a newer seat change replaced the ref, that change's own workflow owns
  // delivery — exit. self_serve orgs whose subscription isn't in good
  // standing (canceled/none) grant 0 regardless of seat flags: seats describe
  // WHO is paid-for, the subscription is whether anyone is paying at all.
  // invoiced (contract) orgs have no Stripe status — their seats always count.
  const state = await DBOS.runStep(
    async () => {
      const s = storage();
      const [billing, paidSeatUserIds] = await Promise.all([
        s.getBilling(organizationId),
        s.listPaidSeatUserIds(organizationId),
      ]);
      const subscriptionGood =
        billing?.billingMode !== "self_serve" ||
        billing.status === "active" ||
        billing.status === "past_due";
      return {
        pendingRef: billing?.benefitsReferenceId ?? null,
        paidSeatCount: subscriptionGood ? paidSeatUserIds.length : 0,
      };
    },
    { name: "readSeatState", retriesAllowed: true, maxAttempts: 3 },
  );
  if (state.pendingRef !== referenceId) return { delivered: false };

  await DBOS.runStep(
    () => grantAllowance(organizationId, state.paidSeatCount, referenceId),
    // Generous budget: the grant is gateway-idempotent per referenceId, and
    // this is money owed to the customer — outlast a gateway deploy window.
    { name: "grantAllowance", retriesAllowed: true, maxAttempts: 8 },
  );

  await DBOS.runStep(
    () => storage().clearBenefitsPending(organizationId, referenceId),
    { name: "clearPending", retriesAllowed: true, maxAttempts: 3 },
  );

  return { delivered: true };
}

/** Sweep: re-enqueue deliveries whose pending marker went stale. */
async function benefitsSyncSweepFn(): Promise<void> {
  if (!benefitsSyncEnabled()) return;
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
  // DBOS_WORKFLOW_VERSION — see apps/mesh/src/dbos/workflow-version.ts.
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
