/**
 * Subsidized runs — executions of reports-pushed tasks are INCLUDED in the
 * org subscription (the quota in task-quota.ts sells them), so their AI
 * usage bills to a deco-owned gateway key instead of the org's own credits.
 * The model is untouched: whatever the org's config resolves runs as-is —
 * only the payer changes.
 *
 * The stamp rides `runMetadata` (server-stamped at enqueue, frozen into the
 * durable dispatch input — never client-supplied on this path) and the swap
 * happens at the single credential-fetch site in dispatch-run.
 *
 * `resolveSubsidizedApiKey` is the deliberate seam for future rules
 * (per-org overrides, dynamic key/model selection from a DB table): today
 * it reads one env-configured house key; swap its body, nothing else moves.
 */

import { decoAiGatewayAdapter } from "@/ai-providers/adapters/deco-ai-gateway";
import { mintGatewayJwt } from "@/auth/jwt";
import type { StudioContext } from "@/core/studio-context";
import { getSettings } from "../settings";
import { isReportsTask } from "./task-quota";

/** runMetadata key. NOTE: runMetadata keys are forwarded as outbound headers
 *  to MCP servers (mcp-clients/outbound/headers.ts) — this flag is harmless
 *  there, but never put a secret next to it. */
export const RUN_BILLING_METADATA_KEY = "runBilling";
export const SUBSCRIPTION_BILLING = "subscription";

/** The runMetadata every task run carries; reports tasks additionally get
 *  the subscription-billing stamp. */
export function taskRunMetadata(task: {
  id: string;
  createdBy: string;
}): Record<string, string> {
  return {
    taskBoardItemId: task.id,
    ...(isReportsTask(task) && {
      [RUN_BILLING_METADATA_KEY]: SUBSCRIPTION_BILLING,
    }),
  };
}

/** Whether a run's metadata carries the subscription-billing stamp. */
export function isSubscriptionBilledRun(
  runMetadata: Record<string, string> | undefined,
): boolean {
  return runMetadata?.[RUN_BILLING_METADATA_KEY] === SUBSCRIPTION_BILLING;
}

/** The synthetic gateway org a client org's subsidy key lives under —
 *  internal on the gateway side (INTERNAL_ORG_PREFIXES=subsidy:), so it's
 *  metered per client without holding deposits. */
export function subsidyGatewayOrgId(organizationId: string): string {
  return `subsidy:${organizationId}`;
}

/**
 * The payer for a subsidized run, best first:
 *  1. the org's cached PER-CLIENT subsidy key (exact COGS attribution);
 *  2. provision one on the fly under `subsidy:<orgId>` (idempotent at the
 *     gateway) and cache it;
 *  3. the single house key (STUDIO_SUBSIDIZED_GATEWAY_KEY), if configured;
 *  4. undefined — the run stays on the org's own key (never fail a run
 *     over billing routing).
 */
export async function resolveSubsidizedApiKey(
  ctx: StudioContext,
  organizationId: string,
): Promise<string | undefined> {
  const settings = getSettings();
  try {
    const cached = await ctx.storage.subsidizedGatewayKeys.get(organizationId);
    if (cached) return cached;
    const userId = ctx.auth?.user?.id;
    if (
      userId &&
      settings.aiGatewayEnabled &&
      settings.studioProvisionSecretKey &&
      decoAiGatewayAdapter.provisionKey
    ) {
      const jwt = await mintGatewayJwt(userId, ctx.auth?.user?.email);
      const key = await decoAiGatewayAdapter.provisionKey(
        jwt,
        subsidyGatewayOrgId(organizationId),
      );
      await ctx.storage.subsidizedGatewayKeys.put(organizationId, key);
      return key;
    }
  } catch (err) {
    console.error(
      "[subsidized-runs] per-org subsidy key unavailable — falling back:",
      err,
    );
  }
  return settings.subsidizedGatewayApiKey;
}

/**
 * Pure payer swap, applied after the org's credential resolves. Requires the
 * stamp, the deco provider (a custom provider is the org's explicit choice
 * and stays on their bill), and a resolved subsidy key (none ⇒ dormant,
 * self-hosted unaffected).
 */
export function applySubsidizedBilling<
  T extends { providerId: string; apiKey: string },
>(
  source: T,
  runMetadata: Record<string, string> | undefined,
  subsidyApiKey: string | undefined,
): T {
  if (!isSubscriptionBilledRun(runMetadata)) return source;
  if (source.providerId !== "deco") return source;
  if (!subsidyApiKey) return source;
  return { ...source, apiKey: subsidyApiKey };
}
