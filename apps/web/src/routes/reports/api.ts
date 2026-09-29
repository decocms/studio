// Thin client for the reports proxy (`/api/_reports/*`).

import type {
  ReportState,
  ResolvedLinkToken,
  ScanStatus,
  ScanTrigger,
} from "@decocms/shared/reports/public-report";

class ReportsApiError extends Error {
  constructor(readonly status: number) {
    super(`reports API HTTP ${status}`);
    this.name = "ReportsApiError";
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ReportsApiError(res.status);
  return (await res.json()) as T;
}

/** Read the report for an already-scanned domain (instant). `lang` renders it
 *  in the viewer's locale (e.g. "pt-BR", "en"); omitted → the site default. */
export function getReport(domain: string, lang?: string): Promise<ReportState> {
  const qs = lang ? `?${new URLSearchParams({ lang }).toString()}` : "";
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

/** The report as Markdown, served by the API at `/report/:domain.md`, in
 *  `lang` (the language the page's findings are in). */
export function reportMarkdownPath(domain: string, lang?: string): string {
  const qs = lang ? `?${new URLSearchParams({ lang }).toString()}` : "";
  return `/report/${encodeURIComponent(domain)}.md${qs}`;
}
