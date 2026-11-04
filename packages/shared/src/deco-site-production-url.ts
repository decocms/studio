import { slugify } from "./utils/slugify";

/**
 * Site-URL helpers for linked deco.cx sites.
 *
 * The URL the CMS preview renders against is persisted on the agent's
 * `metadata.previewServerUrl` (legacy key: `metadata.productionUrl` — written
 * by imports before the rename and still read as a fallback). It is usually
 * the live production site, but any deco-runtime deployment works (staging, a
 * local `https://localhost:3100`, ...), which is why the canonical name is
 * "preview server". Imports default it to the site's `{slug}.deco.site` guess
 * (see `defaultPreviewServerUrl`) rather than a reported custom domain, so the
 * preview always targets the deco-runtime host.
 */

/** Validate/normalize a stored site URL. Returns the canonical href or `null`. */
export function sanitizeSiteUrl(
  value: string | null | undefined,
): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The ONE reader for the preview server URL: `previewServerUrl` wins, the
 * legacy `productionUrl` key is the fallback. Every consumer (web gate, API
 * gate, preview surfaces) goes through here so the dual-read lives in exactly
 * one place; writers write `previewServerUrl` only.
 */
export function resolvePreviewServerUrl(
  metadata:
    | { previewServerUrl?: string | null; productionUrl?: string | null }
    | null
    | undefined,
): string | null {
  return (
    sanitizeSiteUrl(metadata?.previewServerUrl) ??
    sanitizeSiteUrl(metadata?.productionUrl)
  );
}

/**
 * Pick the site's production domain from the deco.cx `domains` list: the one
 * flagged `production`, else the first. Returns `undefined` when there are none.
 */
export function pickProductionDomain(
  domains: { domain: string; production: boolean }[] | null | undefined,
): string | undefined {
  return domains?.find((d) => d.production)?.domain ?? domains?.[0]?.domain;
}

/**
 * Build a site URL from a deco.cx domain. Domains come back as bare hosts
 * (e.g. `acme.com`, `acme.deco.site`), so we prepend `https://` when no scheme
 * is present, then validate. Returns `null` for empty/whitespace/invalid input.
 */
export function productionUrlFromDomain(
  domain: string | null | undefined,
): string | null {
  const raw = domain?.trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return sanitizeSiteUrl(withProtocol);
}

/**
 * Guess a site's deco.site preview host from its display name. `siteName` is
 * a free-text title (shown as-is in the import picker), not a hostname, so it
 * is slugified first — an unslugified name with a space or symbol makes
 * `new URL()` throw, and `productionUrlFromDomain` swallows that into `null`,
 * silently leaving the imported site with no preview server at all.
 */
export function defaultPreviewServerUrl(
  siteName: string | null | undefined,
): string | null {
  const slug = slugify(siteName ?? "");
  if (!slug) return null;
  return productionUrlFromDomain(`${slug}.deco.site`);
}

/** A host a deco runtime renders a draft on without being told to: its own preview hosts, and loopback. */
function isDecoPreviewHost(hostname: string): boolean {
  return (
    hostname.endsWith(".deco.site") ||
    hostname.endsWith(".deco-cx.workers.dev") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Where a draft of the site can render.
 *
 * A deco runtime honors `?__draft=` only on its preview hosts — the
 * `<site>.deco.site` and `<site>.deco-cx.workers.dev` it infers from its own
 * name, and whatever its `site` block lists in `previewHosts` — and quietly
 * renders the published page anywhere else. A preview server set to the
 * production domain shows every draft as if it did not exist, so this keeps
 * the preview server where it can show one and falls back to the site's
 * deco.site host otherwise.
 */
export function draftPreviewServerUrl(args: {
  previewServerUrl: string | null;
  /** What the site's `site` block declares under `previewHosts`. */
  previewHosts?: unknown;
  /** The site's name on deco, which its preview hosts carry. */
  siteName?: string | null;
}): string | null {
  const configured = args.previewServerUrl;
  if (configured) {
    const { host, hostname } = new URL(configured);
    const declared =
      Array.isArray(args.previewHosts) &&
      args.previewHosts.some(
        (entry) =>
          typeof entry === "string" &&
          entry.trim().toLowerCase() === host.toLowerCase(),
      );
    if (declared || isDecoPreviewHost(hostname)) return configured;
  }
  return defaultPreviewServerUrl(args.siteName) ?? configured;
}
