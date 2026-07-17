export type ReportsSiteUrlResult =
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      error: string;
    };

const EXPLICIT_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const URL_SCHEME_WITH_AUTHORITY_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const BARE_HOST_WITH_PORT_PATTERN = /^[^\s/:?#]+\.[^\s/:?#]+:\d+(?:[/?#]|$)/;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function normalizeReportsSiteUrl(input: string): ReportsSiteUrlResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      ok: false,
      error: "Enter a website URL.",
    };
  }

  const hasExplicitScheme = EXPLICIT_SCHEME_PATTERN.test(trimmed);
  const hasSchemeWithAuthority =
    URL_SCHEME_WITH_AUTHORITY_PATTERN.test(trimmed);
  const isBareHostWithPort = BARE_HOST_WITH_PORT_PATTERN.test(trimmed);

  if (hasExplicitScheme && !hasSchemeWithAuthority && !isBareHostWithPort) {
    return {
      ok: false,
      error: "Use an HTTP or HTTPS website URL.",
    };
  }

  const candidate = hasSchemeWithAuthority ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return {
      ok: false,
      error: "Enter a valid website URL.",
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      error: "Use an HTTP or HTTPS website URL.",
    };
  }

  const labels = url.hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !label || !DNS_LABEL_PATTERN.test(label))
  ) {
    return {
      ok: false,
      error: "Enter a valid website URL.",
    };
  }

  url.protocol = "https:";

  return {
    ok: true,
    value: url.origin,
  };
}

/**
 * True when an already-provisioned Reports connection's claimed
 * site matches the one currently requested.
 *
 * An empty `requestedSite` means no site was specified (a returning session
 * with no `?siteUrl`) — trust the existing claim. A non-empty but malformed
 * `requestedSite` must NOT be treated the same as "no site requested": both
 * fail `normalizeReportsSiteUrl`, but only the empty case should bypass the
 * match check — otherwise a garbled site param silently skips re-claiming
 * and surfaces whatever site the connection happens to already be claimed
 * for.
 */
export function isConnectionClaimedForSite(
  requestedSite: string,
  claimedSiteUrl: string | undefined,
): boolean {
  if (!requestedSite.trim()) return true;
  const requested = normalizeReportsSiteUrl(requestedSite);
  if (!requested.ok || !claimedSiteUrl) return false;
  const claimed = normalizeReportsSiteUrl(claimedSiteUrl);
  return claimed.ok && claimed.value === requested.value;
}

/**
 * Hostname derived from a raw site URL (e.g. "fila.com.br"), or `null` when the
 * input is missing or not a valid site URL. Used for analytics `domain` tags and
 * the site badge across the commerce onboarding flow.
 */
export function siteUrlToHost(siteUrl?: string): string | null {
  if (!siteUrl) return null;
  const normalized = normalizeReportsSiteUrl(siteUrl);
  return normalized.ok ? new URL(normalized.value).hostname : null;
}
