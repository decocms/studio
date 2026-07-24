/**
 * Reports-service internal client for the subscription benefits: the weekly
 * run switch and paid runs. Same service + master key as the Commerce
 * Discovery tools (see tools/reports/auth-client) — one setting, two env
 * names during the rename transition.
 */

import { getSettings } from "../settings";

function config(): { baseUrl: string; apiKey: string } | null {
  const settings = getSettings();
  const baseUrl = settings.reportsInternalApiUrl?.replace(/\/+$/, "");
  const apiKey = settings.reportsInternalApiKey;
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

/** Whether this deployment can reach the reports service at all. */
export function reportsClientConfigured(): boolean {
  return config() !== null;
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cfg = config();
  if (!cfg) throw new Error("reports service not configured");
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!res.ok) {
    throw new Error(
      `reports ${path} failed (${res.status}): ${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

/** Arm/disarm the weekly re-run for an org-owned site. Idempotent. */
export async function setReportSchedule(input: {
  host: string;
  organizationId: string;
  enabled: boolean;
}): Promise<void> {
  await post(
    `/api/v2/internal/diagnostics/${encodeURIComponent(input.host)}/schedule`,
    { org_id: input.organizationId, enabled: input.enabled },
  );
}

/** Trigger a PAID run (billed against the org's AI credits at completion —
 *  the caller pre-checks the balance). */
export async function startPaidReportRun(input: {
  host: string;
  organizationId: string;
}): Promise<{ run: unknown }> {
  const out = await post(
    `/api/v2/internal/diagnostics/${encodeURIComponent(input.host)}/run-paid`,
    { org_id: input.organizationId },
  );
  return { run: out.run ?? out };
}
