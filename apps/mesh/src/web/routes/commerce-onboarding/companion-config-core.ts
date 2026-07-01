export interface GaPropertyOption {
  /** Full GA resource name, e.g. "properties/273245903". */
  value: string;
  label: string;
}

export interface GaPropertyGroup {
  account: string;
  options: GaPropertyOption[];
}

export interface VerifiedSite {
  siteUrl: string;
}

interface RawPropertySummary {
  property?: unknown;
  displayName?: unknown;
}
interface RawAccountSummary {
  displayName?: unknown;
  propertySummaries?: unknown;
}

/** Parse get-account-summaries structuredContent into grouped options.
 * Shape: { response: { accountSummaries: [{ displayName, propertySummaries:
 * [{ property, displayName }] }] } }. Groups with no properties are dropped. */
export function parseAccountSummaries(raw: unknown): GaPropertyGroup[] {
  const summaries = (
    raw as { response?: { accountSummaries?: unknown } } | null | undefined
  )?.response?.accountSummaries;
  if (!Array.isArray(summaries)) return [];
  const groups: GaPropertyGroup[] = [];
  for (const acc of summaries as RawAccountSummary[]) {
    const props = acc?.propertySummaries;
    if (!Array.isArray(props)) continue;
    const options: GaPropertyOption[] = [];
    for (const p of props as RawPropertySummary[]) {
      if (typeof p?.property === "string" && p.property.length > 0) {
        options.push({
          value: p.property,
          label: typeof p.displayName === "string" ? p.displayName : p.property,
        });
      }
    }
    if (options.length === 0) continue;
    groups.push({
      account:
        typeof acc?.displayName === "string" ? acc.displayName : "Account",
      options,
    });
  }
  return groups;
}

export function flattenGaOptions(
  groups: GaPropertyGroup[],
): GaPropertyOption[] {
  return groups.flatMap((g) => g.options);
}

/** Parse list_sites structuredContent { sites: [{ siteUrl }] }. */
export function parseListSites(raw: unknown): VerifiedSite[] {
  const sites = (raw as { sites?: unknown } | null | undefined)?.sites;
  if (!Array.isArray(sites)) return [];
  return (sites as Array<{ siteUrl?: unknown }>)
    .filter((s) => typeof s?.siteUrl === "string" && s.siteUrl.length > 0)
    .map((s) => ({ siteUrl: s.siteUrl as string }));
}

/** Normalize a verified siteUrl to a bare host for comparison.
 * "sc-domain:example.com" -> "example.com"; "https://www.x.com/" -> "x.com". */
function siteUrlToHost(siteUrl: string): string | null {
  const stripWww = (h: string) => h.replace(/^www\./, "").toLowerCase();
  if (siteUrl.startsWith("sc-domain:")) {
    return stripWww(siteUrl.slice("sc-domain:".length));
  }
  try {
    return stripWww(new URL(siteUrl).hostname);
  } catch {
    return null;
  }
}

/** Pick the single verified siteUrl whose host matches `host`.
 * Returns null when host is null, nothing matches, or the match is ambiguous
 * (more than one verified property shares the host). */
export function matchVerifiedSite(
  host: string | null,
  sites: VerifiedSite[],
): string | null {
  if (!host) return null;
  const target = host.replace(/^www\./, "").toLowerCase();
  const matches = sites.filter((s) => siteUrlToHost(s.siteUrl) === target);
  return matches.length === 1 ? matches[0]!.siteUrl : null;
}

export function isConfigured(
  state: Record<string, unknown> | null | undefined,
  anchorField: string,
): boolean {
  const v = state?.[anchorField];
  return typeof v === "string" ? v.length > 0 : v != null;
}

export function mergeConfigState(
  state: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(state ?? {}), ...patch };
}
