/**
 * syncOrgBenefits — propagate an org's paid-seat count to the benefits it
 * buys. ONE function, called from every place seats change: the invoiced
 * seat-apply today, the Stripe webhooks (checkout / subscription.updated /
 * invoice.paid) in phase 3.
 *
 * Benefit 1 — AI-gateway monthly allowance: paid_seats × seatAllowanceCents
 * ($5 default), granted via the gateway's idempotent
 * `POST /api/admin/allowance` (referenceId dedupes retries; the gateway
 * REBASES per call — a mid-cycle seat change refreshes the current cycle's
 * allowance, the same accepted slack as the plan's multi-subscription rule).
 *
 * Benefit 2 — weekly report re-run for included_report_url:
 * TODO(billing/4.1): call the reports internal schedule endpoint once it
 * exists (set next_scheduled_run_at when paidSeatCount >= 1, clear at 0).
 *
 * Fail-soft BY THE CALLER's choice: this function throws on failure so the
 * caller decides (the seat tool reports benefitsSynced=false and the next
 * apply self-heals — every call re-grants the full current amount).
 */

import { retry } from "@decocms/std";
import { getSettings } from "../settings";

const MICROS_PER_CENT = 10_000;

export function computeAllowanceMicros(
  paidSeatCount: number,
  seatAllowanceCents: number,
): number {
  return paidSeatCount * seatAllowanceCents * MICROS_PER_CENT;
}

export interface SyncOrgBenefitsResult {
  /** false = deployment has no gateway admin configured (sync skipped). */
  allowanceSynced: boolean;
}

export async function syncOrgBenefits(input: {
  organizationId: string;
  paidSeatCount: number;
  /** Idempotency key for THIS billing event (seat apply id / Stripe invoice
   *  id). Retries with the same id are no-ops on the gateway. */
  referenceId: string;
}): Promise<SyncOrgBenefitsResult> {
  const settings = getSettings();
  if (!settings.aiGatewayEnabled || !settings.aiGatewayAdminToken) {
    return { allowanceSynced: false };
  }

  const amountMicros = computeAllowanceMicros(
    input.paidSeatCount,
    settings.seatAllowanceCents,
  );

  await retry(
    async () => {
      const res = await fetch(`${settings.aiGatewayUrl}/api/admin/allowance`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.aiGatewayAdminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orgId: input.organizationId,
          amountMicros,
          referenceId: input.referenceId,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `gateway allowance grant failed (${res.status}): ${body}`,
        );
      }
    },
    { maxAttempts: 3, minTimeout: 500, maxTimeout: 4_000 },
  );

  return { allowanceSynced: true };
}
