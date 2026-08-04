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

export function resolveSubsidizedApiKey(): string | undefined {
  return getSettings().subsidizedGatewayApiKey;
}

/**
 * Applied after the org's credential resolves: swap ONLY the payer. The swap
 * requires all three of — the run is stamped, the resolved provider is the
 * deco gateway (a custom provider is the org's explicit choice and stays on
 * their bill), and a house key is configured (unset ⇒ feature dormant,
 * self-hosted unaffected).
 */
export function applySubsidizedBilling<
  T extends { providerId: string; apiKey: string },
>(
  source: T,
  runMetadata: Record<string, string> | undefined,
  houseApiKey: string | undefined = resolveSubsidizedApiKey(),
): T {
  if (runMetadata?.[RUN_BILLING_METADATA_KEY] !== SUBSCRIPTION_BILLING) {
    return source;
  }
  if (source.providerId !== "deco") return source;
  if (!houseApiKey) return source;
  return { ...source, apiKey: houseApiKey };
}
