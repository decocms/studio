// Per-report SEO + favicon helpers. Pure and isomorphic (safe in the Hono
// head-rewrite route, the OG-image renderer, and client components).

/**
 * Reduce a route param (which may arrive as `https://nike.com/path`, `Nike.com`,
 * or `www.nike.com`) to a bare, lower-cased hostname suitable for a favicon
 * lookup and display.
 */
export function normalizeDomain(raw: string): string {
  let d = (raw ?? "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split(/[/?#]/)[0] ?? "";
  return d.replace(/\/+$/, "");
}

/** Turn a domain into a Title-Cased brand guess (`nike.com` → `Nike`). */
export function brandFromDomain(domain: string): string {
  const label = normalizeDomain(domain).split(".")[0] || domain;
  return label
    .replace(/[-_]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The scanned domain's own favicon, via Google's keyless service. */
export function faviconForDomain(domain: string, size = 64): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
    normalizeDomain(domain),
  )}&sz=${size}`;
}

/** The origin-relative report page path for a scanned domain. */
export function reportPath(rawUrlParam: string): string {
  return `/report/${encodeURIComponent(normalizeDomain(rawUrlParam))}`;
}

/** Trim to a max length on a word boundary, appending an ellipsis when cut. */
export function clampText(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(
    lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice
  ).trimEnd()}…`;
}

/** Build the title and description used by report pages and share cards. */
export function reportShareCopy(opts: {
  brand: string;
  domain: string;
  score?: number | null;
  verdict?: string | null;
}): { title: string; description: string } {
  const { brand, domain, score, verdict } = opts;

  const title =
    typeof score === "number"
      ? `${brand} commerce report — ${Math.round(score)}/100 · decocms`
      : `${brand} commerce report · decocms`;

  const tail = `See the full ${brand} scorecard — SEO, performance, conversion & AEO signals scored by decocms.`;
  const description = verdict?.trim()
    ? clampText(`${verdict.trim().replace(/\s+/g, " ")} — ${tail}`, 200)
    : clampText(`How does ${domain} really perform? ${tail}`, 200);

  return { title, description };
}
