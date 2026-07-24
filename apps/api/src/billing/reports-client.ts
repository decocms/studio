/**
 * Reports-service internal client for the subscription benefits: the weekly
 * run switch and paid runs. Same service + master key as the Commerce
 * Discovery tools — base-URL resolution is shared with
 * tools/reports/auth-client so "configured" means the same thing everywhere:
 * the key is required, the URL falls back to the well-known default.
 *
 * These are master-key endpoints: the reports service is the authority on
 * whether `org_id` owns/claims `host` — mesh only validates the host's shape.
 */

import { getSettings } from "../settings";
import { resolveBaseUrl } from "../tools/reports/auth-client";

/** Whether this deployment can reach the reports service at all. */
export function reportsClientConfigured(): boolean {
  return !!getSettings().reportsInternalApiKey;
}

export class ReportsClientError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ReportsClientError";
    this.status = status;
  }
}

/** 4xx = the service rejected the request itself (unknown/unowned host, bad
 *  input) — retrying the same call can never succeed. */
export function isPermanentReportsFailure(err: unknown): boolean {
  return (
    err instanceof ReportsClientError && err.status >= 400 && err.status < 500
  );
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const apiKey = getSettings().reportsInternalApiKey;
  if (!apiKey) throw new Error("reports service not configured");
  const res = await fetch(`${resolveBaseUrl({})}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
    throw new ReportsClientError(
      res.status,
      `reports ${path} failed (${res.status}): ${JSON.stringify(parsed).slice(0, 500)}`,
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
