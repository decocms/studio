export type CommerceSiteUrlResult =
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

export function normalizeCommerceSiteUrl(input: string): CommerceSiteUrlResult {
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
