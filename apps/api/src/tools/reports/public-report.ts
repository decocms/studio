import {
  type OnePager,
  OnePagerSchema,
} from "@decocms/shared/reports/public-report";
import { resolveBaseUrl } from "./auth-client";

/** The engine's anonymous one-pager routes for a domain. */
function onePagerUrl(domain: string, suffix: "" | ".md", lang?: string) {
  const qs = lang ? `?${new URLSearchParams({ lang }).toString()}` : "";
  return `${resolveBaseUrl({})}/api/v2/public/diagnostics/${encodeURIComponent(
    domain,
  )}/onepager${suffix}${qs}`;
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
  opts: { signal?: AbortSignal } = {},
): Promise<string | null> {
  const res = await fetch(onePagerUrl(domain, ".md"), {
    headers: { Accept: "text/markdown" },
    signal: opts.signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`onepager markdown HTTP ${res.status}`);
  return res.text();
}
