/**
 * Subsidized runs — executions of reports-pushed tasks are INCLUDED in the
 * org subscription (the quota in task-quota.ts sells them), so their AI
 * usage bills to a deco-owned gateway key instead of the org's own credits.
 * The model is untouched: whatever the org's config resolves runs as-is —
 * only the payer changes.
 *
 * SECURITY: this swap decides who pays real money, so the signal must be
 * unforgeable. Two independent barriers:
 *  1. The stamp lives under the RESERVED `srv.` runMetadata namespace, which
 *     `sanitizeClientRunMetadata` strips from every client-supplied bag (the
 *     webhook-trigger body being the one untrusted producer). A caller
 *     cannot set it.
 *  2. The swap CORROBORATES the stamp against server state before spending:
 *     the run's task must belong to this org, be reports-pushed, and already
 *     hold a quota claim. A stamp alone never authorizes the swap.
 *
 * `resolveSubsidizedApiKey` is the deliberate seam for future rules (per-org
 * overrides, dynamic selection): swap its body, nothing else moves.
 */

import { decoAiGatewayAdapter } from "@/ai-providers/adapters/deco-ai-gateway";
import { mintGatewayJwt } from "@/auth/jwt";
import type { StudioContext } from "@/core/studio-context";
import { getSettings } from "../settings";
import { hasTaskQuotaClaim, isReportsTask } from "./task-quota";

/**
 * Reserved runMetadata namespace: keys the SERVER owns. Client-supplied
 * metadata is stripped of this prefix at every untrusted entry point, so a
 * caller can never assert a server fact. New server-owned keys go under it
 * and inherit the protection.
 */
const RESERVED_RUN_METADATA_PREFIX = "srv.";
export const RUN_BILLING_METADATA_KEY = "srv.billing";
export const SUBSCRIPTION_BILLING = "subscription";

/** Drop reserved (server-owned) keys from a client-supplied metadata bag. */
export function sanitizeClientRunMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key.startsWith(RESERVED_RUN_METADATA_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}

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

/** Whether a run's metadata carries the subscription-billing stamp. Only a
 *  hint — `resolveSubsidizedPayer` corroborates it before spending. */
export function isSubscriptionBilledRun(
  runMetadata: Record<string, string> | undefined,
): boolean {
  return runMetadata?.[RUN_BILLING_METADATA_KEY] === SUBSCRIPTION_BILLING;
}

/** The synthetic gateway org a client org's subsidy key lives under —
 *  internal on the gateway side (INTERNAL_ORG_PREFIXES=subsidy:), so it's
 *  metered per client without holding deposits. */
export function subsidyGatewayOrgId(organizationId: string): string {
  // The scheme's delimiter must never appear in the org id, or one org could
  // address another's bucket. Org ids are server-generated (Better Auth), so
  // this is insurance against a future id-supplying path.
  if (/[:\s]/.test(organizationId)) {
    throw new Error("organization id unsuitable for the subsidy key scheme");
  }
  return `subsidy:${organizationId}`;
}

/**
 * The payer key, best first:
 *  1. the org's cached PER-CLIENT subsidy key (exact COGS attribution);
 *  2. provision one under `subsidy:<orgId>` (idempotent at the gateway) and
 *     cache it;
 *  3. undefined — the run stays on the org's own key (never fail a run over
 *     billing routing; the next run retries the provision).
 */
async function resolveSubsidizedApiKey(
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
      "[subsidized-runs] subsidy key unavailable — run stays on the org's key:",
      err,
    );
  }
  return undefined;
}

/**
 * Resolve the subsidy payer for a run, or undefined to leave it on the org's
 * own key. Gated on all of:
 *  - the quota is enforced (the spending half must never outrun the limiting
 *    half: with the flag off, nothing is subsidized);
 *  - the run carries the server-owned stamp;
 *  - the stamp corroborates — the named task is THIS org's, reports-pushed,
 *    and already claimed.
 *
 * ONE call per dispatch: callers must not re-resolve per model slot (that
 * would N-way race the first-use provisioning).
 */
export async function resolveSubsidizedPayer(
  ctx: StudioContext,
  organizationId: string,
  runMetadata: Record<string, string> | undefined,
): Promise<string | undefined> {
  if (!getSettings().taskQuotaEnforced) return undefined;
  if (!isSubscriptionBilledRun(runMetadata)) return undefined;
  const taskId = runMetadata?.taskBoardItemId;
  if (!taskId) return undefined;
  const task = await ctx.storage.taskBoard.getById(taskId, organizationId);
  if (!task || !isReportsTask(task)) return undefined;
  if (!(await hasTaskQuotaClaim(ctx, taskId))) return undefined;
  return await resolveSubsidizedApiKey(ctx, organizationId);
}

/**
 * Pure payer swap. Requires a resolved subsidy key (see
 * `resolveSubsidizedPayer` for the gating) and the deco provider — a custom
 * provider is the org's explicit choice and stays on their bill.
 */
export function applySubsidizedBilling<
  T extends { providerId: string; apiKey: string },
>(source: T, subsidyApiKey: string | undefined): T {
  if (!subsidyApiKey) return source;
  if (source.providerId !== "deco") return source;
  return { ...source, apiKey: subsidyApiKey };
}
