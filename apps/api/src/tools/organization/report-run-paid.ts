/**
 * ORGANIZATION_REPORT_RUN_PAID — trigger an extra/paid report run, billed
 * against the org's AI credits. The included weekly run is free; this is for
 * "re-run now" or additional sites. Guards:
 *  - org must have AI credit balance ≥ MIN_PAID_RUN_BALANCE_CENTS ($5) — the
 *    run's real cost × markup is debited at completion by the reports
 *    service; overrun beyond the minimum is absorbed (plan decision, and it
 *    also bounds what concurrent calls passing the same pre-check can cost);
 *  - defaults to the org's included report site when no url is given.
 */

import { z } from "zod";
import {
  reportsClientConfigured,
  startPaidReportRun,
} from "../../billing/reports-client";
import { defineTool } from "../../core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "../../core/studio-context";
import { getProviders } from "../../ai-providers/registry";
import { mintGatewayJwt } from "../../auth/jwt";
import { siteUrlToHost } from "@decocms/shared/reports/site-url";

const MIN_PAID_RUN_BALANCE_CENTS = 500;

/** `[CREDITS]` prefix is a wire contract with the frontend's credit-error
 *  detection (see access-control.ts / is-credit-error.ts) — do not drop it. */
export function insufficientBalanceMessage(balanceCents: number): string {
  return `[CREDITS] Paid report runs need at least $${(MIN_PAID_RUN_BALANCE_CENTS / 100).toFixed(2)} of AI credit balance — current balance is $${(balanceCents / 100).toFixed(2)}. Top up and try again.`;
}

export const ORGANIZATION_REPORT_RUN_PAID = defineTool({
  name: "ORGANIZATION_REPORT_RUN_PAID",
  description:
    "Trigger a paid report run for one of the organization's sites, billed against its AI credits (requires at least $5 of balance; the run's real cost plus markup is debited at completion).",
  annotations: {
    title: "Run Paid Report",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    /** Site host; defaults to the org's included report site. */
    url: z.string().trim().min(1).max(255).optional(),
  }),
  outputSchema: z.object({
    url: z.string(),
    started: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");
    if (!reportsClientConfigured()) {
      throw new Error("Reports are not available on this deployment.");
    }

    let host: string | null;
    if (input.url) {
      host = siteUrlToHost(input.url);
    } else {
      const billing = await ctx.storage.organizationBilling.getBilling(org.id);
      host = billing?.includedReportUrl ?? null;
    }
    if (!host) {
      throw new Error(
        input.url
          ? `"${input.url}" is not a valid site URL.`
          : "No site chosen — pass a url or set the included report site first.",
      );
    }

    // Balance pre-check (plan: ≥ $5 to trigger; overrun absorbed). Uses the
    // org's live gateway balance — the same number the credits UI shows. Via
    // getProviders() so the aiGatewayEnabled gate applies like every other
    // gateway-backed tool.
    const adapter = getProviders().deco;
    if (!adapter?.getCreditsBalance) {
      throw new Error("AI credit balance is not available on this deployment.");
    }
    const meshJwt = await mintGatewayJwt(userId, ctx.auth.user?.email);
    const { balanceCents } = await adapter.getCreditsBalance(meshJwt, org.id);
    // Inverted so an unexpected gateway response shape (balanceCents
    // undefined/NaN) fails closed instead of skipping the guard.
    if (!(balanceCents >= MIN_PAID_RUN_BALANCE_CENTS)) {
      throw new Error(insufficientBalanceMessage(balanceCents ?? 0));
    }

    await startPaidReportRun({ host, organizationId: org.id });
    return { url: host, started: true };
  },
});
