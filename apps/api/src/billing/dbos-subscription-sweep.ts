/**
 * The backstop for a Stripe webhook that never arrived.
 *
 * Every path back to Free runs through `stripe-webhook.ts`, and that is a
 * single point of failure we do not own: Stripe retries a failing endpoint for
 * about three days and then DISABLES it. A `customer.subscription.deleted` lost
 * in that window left the org holding its paid tier, its gated features and a
 * provider key funded by the plan's allowance — for ever, because nothing else
 * reads `current_period_end`. Revenue protection, and the one gap in this
 * feature where the failure mode pointed the expensive way.
 *
 * It does not GUESS. A row whose period has visibly lapsed is only a signal
 * that we stopped hearing; the sweep then asks Stripe what is true and applies
 * that. Reading the subscription is what makes it safe to run against live
 * billing state.
 *
 * REVOKE-ONLY, deliberately. It reuses `planIdForStripe` verbatim — the
 * webhook's own rule, whose return type is "free or nothing" — rather than
 * inventing a second place that can grant a paid tier. The asymmetry is the
 * point: a missed revocation costs deco money silently and indefinitely, a
 * missed grant is a customer who tells us within the minute. Grants stay the
 * exclusive property of money clearing.
 *
 * Same shape as `dbos-archive-sweep.ts`: one pod per tick, the work list read
 * inside a step so a replay iterates the recorded list, each org its own
 * never-throwing step.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { invalidateOrgFeaturesEverywhere } from "./plan-cache-broadcast";
import type { Database } from "@/storage/types";
import {
  OrganizationBillingStorage,
  type OrganizationBillingRow,
} from "../storage/organization-billing";
import { retrieveSubscription, StripeApiError } from "./stripe-api";
import { setGatewayOrgPlan, GatewayAdminPermanentError } from "./gateway-admin";
import { mapSubscriptionStatus, planIdForStripe } from "./stripe-webhook";
import { getSettings } from "../settings";

/** Hourly at :41 — off every other sweep's tick, so one pod never runs two. */
const SUBSCRIPTION_SWEEP_CRONTAB = "41 * * * *";

/**
 * How far past `current_period_end` a row has to be before we go asking.
 *
 * Wide on purpose. A renewal's `invoice.paid` normally lands within seconds,
 * but a failed one starts Stripe's dunning, which keeps the subscription
 * `past_due` — a state the webhook treats as grace and this must not
 * second-guess. Two days is long past any healthy renewal and well short of
 * Stripe's retry schedule, so the only rows that reach here are ones we have
 * genuinely stopped hearing about.
 */
const LAPSED_GRACE_MS = 2 * 24 * 60 * 60 * 1000;

/** Each org costs one Stripe read; a backlog drains over the following hours. */
const MAX_ORGS_PER_TICK = 100;

export interface SubscriptionSweepRuntime {
  db: Kysely<Database>;
}

let runtime: SubscriptionSweepRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`:
 *  it only writes a module-level pointer, no DBOS API calls. */
export function setSubscriptionSweepRuntime(
  rt: SubscriptionSweepRuntime,
): void {
  runtime = rt;
}

function requireRuntime(): SubscriptionSweepRuntime {
  if (!runtime) {
    throw new Error(
      "[subscription-sweep] runtime not initialized — setSubscriptionSweepRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

type SweepOutcome =
  | { organizationId: string; action: "ok" | "revoked" | "gone" }
  | { organizationId: string; action: "failed"; error: string };

/**
 * One lapsed org, folded to a result — the step body must never throw.
 *
 * Three answers from Stripe, and each of them is applied the way the webhook
 * would have applied the event we never received:
 *
 *  - 404: the subscription no longer exists. That is `subscription.deleted`
 *    arriving late by another route — cancel the row, UNBIND it (so a fresh
 *    checkout can bind again) and drop the org to Free.
 *  - a live subscription: mirror its status and period end, then let
 *    `planIdForStripe` decide. `active` and `past_due` both leave the plan
 *    alone; everything else revokes.
 *  - anything else (5xx, timeout): leave the row exactly as it is and try again
 *    next tick. A Stripe outage must not revoke anybody.
 */
async function sweepOneOrg(
  billing: OrganizationBillingRow,
): Promise<SweepOutcome> {
  const organizationId = billing.organizationId;
  const subscriptionId = billing.stripeSubscriptionId;
  if (!subscriptionId) return { organizationId, action: "ok" };

  const storage = new OrganizationBillingStorage(requireRuntime().db);
  try {
    let status: string;
    let periodEnd: Date | null;
    let unbind = false;
    try {
      const subscription = await retrieveSubscription(subscriptionId);
      status = mapSubscriptionStatus(subscription.status);
      periodEnd = subscriptionPeriodEndOf(subscription);
    } catch (err) {
      if (!(err instanceof StripeApiError) || err.status !== 404) throw err;
      // Gone at Stripe. Terminal, exactly as `subscription.deleted` is.
      status = "canceled";
      periodEnd = billing.currentPeriodEnd;
      unbind = true;
    }

    const planId = planIdForStripe(
      status,
      {},
      getSettings().stripePlanPriceIds,
    );

    // The row first, so a failure below leaves us with an accurate record and a
    // plan that is merely too generous — the reverse would tell us the org is
    // free while it still holds every feature.
    await storage.updateStripeState(organizationId, {
      status,
      currentPeriodEnd: periodEnd,
      ...(unbind && { stripeSubscriptionId: null }),
    });

    if (!planId) {
      // Nothing to revoke. The row is now current, so this org will not come
      // back next tick unless it lapses again.
      return { organizationId, action: "ok" };
    }

    await setGatewayOrgPlan({
      organizationId,
      planId,
      note: `studio subscription sweep (${status})`,
    });
    invalidateOrgFeaturesEverywhere(organizationId);
    console.warn(
      "[subscription-sweep] revoked a paid tier whose webhook never arrived",
      { organizationId, subscriptionId, status },
    );
    return { organizationId, action: unbind ? "gone" : "revoked" };
  } catch (err) {
    // A gateway DECISION is worth naming — it will fail the same way every
    // tick until an operator acts, and the org keeps its tier meanwhile.
    if (err instanceof GatewayAdminPermanentError) {
      console.error(
        "[subscription-sweep] gateway REFUSED the revocation — the org still holds a tier it no longer pays for",
        { organizationId, subscriptionId, status: err.status },
      );
    }
    return {
      organizationId,
      action: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Basil moved `current_period_end` onto the items; read both shapes, the way
 *  the webhook does for the same object. */
function subscriptionPeriodEndOf(subscription: {
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
}): Date | null {
  if (typeof subscription.current_period_end === "number") {
    return new Date(subscription.current_period_end * 1000);
  }
  let max = 0;
  for (const item of subscription.items?.data ?? []) {
    if (typeof item.current_period_end === "number") {
      max = Math.max(max, item.current_period_end);
    }
  }
  return max > 0 ? new Date(max * 1000) : null;
}

async function subscriptionSweepWorkflowFn(
  scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  // Nothing to reconcile on a deployment that sells nothing, and no Stripe key
  // to do it with. Checked inside the workflow rather than at registration so
  // flipping the config does not need a restart to take effect.
  const settings = getSettings();
  if (!settings.plansEnabled || !settings.stripeSecretKey) return;

  // Cutoff off the SCHEDULED time, so a replayed tick asks for the same window.
  const lapsedBefore = new Date(scheduledTime.getTime() - LAPSED_GRACE_MS);
  const lapsed = await DBOS.runStep(
    () =>
      new OrganizationBillingStorage(
        requireRuntime().db,
      ).listSubscriptionsPastPeriodEnd(lapsedBefore, MAX_ORGS_PER_TICK),
    { name: "loadLapsedSubscriptions" },
  );
  if (lapsed.length === 0) return;

  const results = await Promise.all(
    lapsed.map((billing) =>
      DBOS.runStep(() => sweepOneOrg(billing), {
        name: `sweepSubscription:${billing.organizationId}`,
      }),
    ),
  );
  for (const result of results) {
    if (result.action === "failed") {
      console.warn(
        `[subscription-sweep] org ${result.organizationId} failed: ${result.error}`,
      );
    }
  }
  const revoked = results.filter(
    (r) => r.action === "revoked" || r.action === "gone",
  ).length;
  if (revoked > 0) {
    console.warn(
      `[subscription-sweep] revoked ${revoked} of ${lapsed.length} lapsed subscriptions`,
    );
  }
}

let registeredWorkflow: typeof subscriptionSweepWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerSubscriptionSweepWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(subscriptionSweepWorkflowFn, {
    name: "subscriptionSweepWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "subscriptionSweepWorkflow",
    crontab: SUBSCRIPTION_SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
