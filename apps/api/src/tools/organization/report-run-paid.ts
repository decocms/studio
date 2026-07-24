/**
 * ORGANIZATION_REPORT_RUN_PAID — trigger an extra/paid report run, billed
 * against the org's AI credits. The included weekly run is free; this is for
 * "re-run now" or additional sites. Guards:
 *  - org must have AI credit balance ≥ MIN_PAID_RUN_BALANCE_CENTS ($5) — the
 *    run's real cost × markup is debited at completion by the reports
 *    service; overrun beyond the minimum is absorbed (plan decision);
 *  - defaults to the org's included report site when no url is given.
 */

import { z } from "zod";
import {
  reportsClientConfigured,
  startPaidReportRun,
} from "../../billing/reports-client";
import { defineTool } from "../../core/define-tool";
import { requireAuth, getUserId } from "../../core/studio-context";
import { decoAiGatewayAdapter } from "../../ai-providers/adapters/deco-ai-gateway";
import { mintGatewayJwt } from "../../auth/jwt";
import { normalizeSiteHost } from "./billing-portal";

const MIN_PAID_RUN_BALANCE_CENTS = 500;

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
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error("Organization context required");
    }
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");
    if (!reportsClientConfigured()) {
      throw new Error("Reports are not available on this deployment.");
    }

    const billing =
      await ctx.storage.organizationBilling.getBilling(organizationId);
    const host = input.url
      ? normalizeSiteHost(input.url)
      : (billing?.includedReportUrl ?? null);
    if (!host) {
      throw new Error(
        input.url
          ? `"${input.url}" is not a valid site URL.`
          : "No site chosen — pass a url or set the included report site first.",
      );
    }

    // Balance pre-check (plan: ≥ $5 to trigger; overrun absorbed). Uses the
    // org's live gateway balance — the same number the credits UI shows.
    if (!decoAiGatewayAdapter.getCreditsBalance) {
      throw new Error("AI credit balance is not available on this deployment.");
    }
    const meshJwt = await mintGatewayJwt(userId, ctx.auth.user?.email);
    const { balanceCents } = await decoAiGatewayAdapter.getCreditsBalance(
      meshJwt,
      organizationId,
    );
    if (balanceCents < MIN_PAID_RUN_BALANCE_CENTS) {
      throw new Error(
        `[CREDITS] Paid report runs need at least $${(MIN_PAID_RUN_BALANCE_CENTS / 100).toFixed(2)} of AI credit balance — current balance is $${(balanceCents / 100).toFixed(2)}. Top up and try again.`,
      );
    }

    await startPaidReportRun({ host, organizationId });
    return { url: host, started: true };
  },
});
