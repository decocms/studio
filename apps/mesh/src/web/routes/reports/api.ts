// Thin client for the authenticated reports proxy (`/api/_reports/*`).
// Mirrors the server types in `@/reports/to-deck`.

import type {
  ReportState,
  ResolvedLinkToken,
  ScanStatus,
  ScanTrigger,
} from "@/reports/to-deck";

class ReportsApiError extends Error {
  constructor(readonly status: number) {
    super(`reports API HTTP ${status}`);
    this.name = "ReportsApiError";
  }
}

export function isReportsUnauthorized(error: unknown): boolean {
  return error instanceof ReportsApiError && error.status === 401;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ReportsApiError(res.status);
  return (await res.json()) as T;
}

/** Read the deck for an already-scanned domain (instant). `lang` renders it in
 *  the viewer's locale (e.g. "pt-BR", "en"); omitted → the site default. */
export function getReport(
  domain: string,
  key?: string,
  lang?: string,
): Promise<ReportState> {
  const params = new URLSearchParams();
  if (key) params.set("key", key);
  if (lang) params.set("lang", lang);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return fetch(`/api/_reports/site/${encodeURIComponent(domain)}${qs}`).then(
    (r) => json<ReportState>(r),
  );
}

/** Trigger a scan. Idempotent + single-flight on the engine side. */
export function runReportScan(input: {
  domain: string;
  distinctId?: string;
}): Promise<ScanTrigger> {
  return fetch("/api/_reports/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json<ScanTrigger>(r));
}

/** Poll a durable run by instance id. */
export function getScanStatus(id: string): Promise<ScanStatus> {
  return fetch(`/api/_reports/status?id=${encodeURIComponent(id)}`).then((r) =>
    json<ScanStatus>(r),
  );
}

/** Resolve an email link's `d` token. Null when never minted (404). */
export function resolveEmailLinkToken(
  id: string,
): Promise<ResolvedLinkToken | null> {
  return fetch(`/api/_reports/link-token/${encodeURIComponent(id)}`).then((r) =>
    json<ResolvedLinkToken | null>(r),
  );
}
