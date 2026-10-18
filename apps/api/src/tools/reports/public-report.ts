import {
  type OnePager,
  OnePagerSchema,
  type ScanStatus,
  type ScanTrigger,
} from "@decocms/shared/reports/public-report";
import { resolveApiKey, resolveBaseUrl } from "./auth-client";

/** The engine's anonymous one-pager routes for a domain. */
function onePagerUrl(domain: string, suffix: "" | ".md", lang?: string) {
  const qs = lang ? `?${new URLSearchParams({ lang }).toString()}` : "";
  return `${resolveBaseUrl({})}/api/v2/public/diagnostics/${encodeURIComponent(
    domain,
  )}/onepager${suffix}${qs}`;
}

/** The engine's public share card for a domain: favicon, URL, score ring and
 *  the captured screenshots. Always an image, even for an unscanned domain. */
export function onePagerImageUrl(domain: string): string {
  return `${resolveBaseUrl({})}/api/v2/public/diagnostics/${encodeURIComponent(
    domain,
  )}/og.png`;
}

/**
 * Read the published one-pager for a domain. Null when the engine has nothing
 * public for it (never scanned, or not approved yet); throws on any other
 * failure, including a body that does not match the contract.
 */
export async function fetchPublicOnePager(
  domain: string,
  opts: { lang?: string; signal?: AbortSignal } = {},
): Promise<OnePager | null> {
  const res = await fetch(onePagerUrl(domain, "", opts.lang), {
    headers: { Accept: "application/json" },
    signal: opts.signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`onepager read HTTP ${res.status}`);
  return OnePagerSchema.parse(await res.json());
}

/** The same report as Markdown, for agents. Null when nothing is published. */
export async function fetchPublicOnePagerMarkdown(
  domain: string,
  opts: { lang?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
  const res = await fetch(onePagerUrl(domain, ".md", opts.lang), {
    headers: { Accept: "text/markdown" },
    signal: opts.signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`onepager markdown HTTP ${res.status}`);
  return res.text();
}

const TERMINAL_SCAN_STATES = new Set([
  "complete",
  "errored",
  "terminated",
  "unknown",
]);

/**
 * Start a scan of `domain` with the master key. The engine is idempotent and
 * single-flight, so repeating this never starts parallel runs. `email` is the
 * requester's notification address; pass it only from a session, never from
 * caller input. Throws when the key is unset or the engine refuses.
 */
export async function startEngineScan(
  domain: string,
  opts: { email?: string; distinctId?: string } = {},
): Promise<ScanTrigger> {
  const res = await fetch(`${resolveBaseUrl({})}/api/v2/diagnostics/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolveApiKey({})}`,
    },
    body: JSON.stringify({
      url: domain,
      ...(opts.email ? { email: opts.email } : {}),
      distinct_id: opts.distinctId,
    }),
  });
  if (!res.ok) throw new Error(`run HTTP ${res.status}`);
  const j = (await res.json()) as {
    id?: string;
    status?: string;
    blocked?: boolean;
    mode?: string;
  };
  return j.blocked
    ? { state: "blocked" }
    : j.status === "fresh"
      ? { state: "fresh" }
      : j.mode === "sync"
        ? { state: "sync" }
        : { state: "running", id: j.id ?? null };
}

/** Poll a durable scan started by {@link startEngineScan}. */
export async function getEngineScanStatus(id: string): Promise<ScanStatus> {
  const res = await fetch(
    `${resolveBaseUrl({})}/api/v2/diagnostics/status?id=${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${resolveApiKey({})}` } },
  );
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  const j = (await res.json()) as { status?: string };
  const status = j.status ?? "unknown";
  return { done: TERMINAL_SCAN_STATES.has(status), status };
}
