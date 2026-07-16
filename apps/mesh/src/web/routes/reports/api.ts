// Thin client for the public reports proxy (`/api/_reports/*`, no auth).
// Mirrors the server types in `@/reports/to-deck`.

import type {
  ReportState,
  ResolvedLinkToken,
  ScanStatus,
  ScanTrigger,
} from "@/reports/to-deck";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`reports API HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Anonymous read — the deck for an already-scanned domain (instant). */
export function getPublicReport(
  domain: string,
  key?: string,
): Promise<ReportState> {
  const qs = key ? `?key=${encodeURIComponent(key)}` : "";
  return fetch(`/api/_reports/site/${encodeURIComponent(domain)}${qs}`).then(
    (r) => json<ReportState>(r),
  );
}

/** Trigger a scan. Idempotent + single-flight on the engine side. */
export function runReportScan(input: {
  domain: string;
  email?: string;
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
