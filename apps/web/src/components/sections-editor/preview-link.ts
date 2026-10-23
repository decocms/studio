/**
 * The preview link's moment and forced A/B tests on a Blocks (v8) site
 * (`@decocms/blocks` draft.ts): two more reserved parameters in the query of
 * the version a `?__draft=` link carries, next to the forced variants
 * (variant-draft-pointer.ts):
 *
 * - `__at=<ISO date-time with offset>`: the moment the preview shows, so
 *   campaigns run as they will then (`client.now`);
 * - `__test=<name>=on|off`: an A/B test forced on or off over the visitor's
 *   own side.
 *
 * Each value is URL-encoded. A draft pointer carries them in its path's query
 * (`<host><path>?__at=…@<version>`); a published release's commit SHA after a
 * `?` (`<sha>?__at=…&__test=…`). The site honours them only from a Studio
 * link on its preview hosts, as it does drafts: a visitor never picks them.
 */

/** What the preview shows besides the content: a moment and forced tests. */
export interface PreviewOptions {
  /** ISO date-time with its offset; absent: now. */
  at?: string;
  /** Per test name, forced on (`true`) or off (`false`); absent: as drawn. */
  tests?: Record<string, boolean>;
}

const AT_PARAM = "__at=";
const TEST_PARAM = "__test=";
/** A published release: its git commit SHA. */
const REVISION_RE = /^[0-9a-f]{40}$/;

export function hasPreviewOptions(options: PreviewOptions): boolean {
  return (
    options.at !== undefined || Object.keys(options.tests ?? {}).length > 0
  );
}

/** Whether a value is a published release's commit SHA. */
export function isReleaseSha(value: string | null | undefined): boolean {
  return typeof value === "string" && REVISION_RE.test(value);
}

/** encodeURIComponent, plus the characters it leaves that a pointer doesn't allow. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function optionParams(options: PreviewOptions): string[] {
  const tests = options.tests ?? {};
  return [
    ...(options.at !== undefined ? [AT_PARAM + encode(options.at)] : []),
    ...Object.keys(tests).map(
      (name) => TEST_PARAM + encode(`${name}=${tests[name] ? "on" : "off"}`),
    ),
  ];
}

/** `query` without any `__at`/`__test`, plus `extra`. */
function mergeQuery(query: string, extra: string[]): string {
  const kept = query
    .split("&")
    .filter(
      (param) =>
        param && !param.startsWith(AT_PARAM) && !param.startsWith(TEST_PARAM),
    );
  const params = [...kept, ...extra];
  return params.length > 0 ? `?${params.join("&")}` : "";
}

/**
 * A version (a draft pointer, or a release's commit SHA with or without
 * preview parameters) with exactly these preview options: any moment or
 * forced tests it carried are replaced, everything else (forced variants
 * included) kept. A value that is neither is returned as it is.
 */
export function withPreviewOptions(
  version: string,
  options: PreviewOptions,
): string {
  const extra = optionParams(options);
  const q = version.indexOf("?");
  const head = q === -1 ? version : version.slice(0, q);
  if (isReleaseSha(head)) {
    return head + mergeQuery(q === -1 ? "" : version.slice(q + 1), extra);
  }
  const at = version.lastIndexOf("@");
  if (at <= 0) return version;
  const location = version.slice(0, at);
  const lq = location.indexOf("?");
  const base = lq === -1 ? location : location.slice(0, lq);
  const query = lq === -1 ? "" : location.slice(lq + 1);
  return `${base}${mergeQuery(query, extra)}${version.slice(at)}`;
}

/**
 * A site URL whose `?__draft=` version carries these preview options. A URL
 * showing the published site (no version, or `off`) previews `release`, the
 * current release's commit SHA, when there are options to carry and it is
 * known; otherwise it stays as it is.
 */
export function withPreviewOptionsInDraftUrl(
  href: string,
  options: PreviewOptions,
  release?: string | null,
): string {
  if (!hasPreviewOptions(options)) return href;
  try {
    const url = new URL(href);
    const version = url.searchParams.get("__draft");
    if (version && version !== "off") {
      url.searchParams.set("__draft", withPreviewOptions(version, options));
      return url.toString();
    }
    if (!isReleaseSha(release)) return href;
    url.searchParams.set("__draft", withPreviewOptions(release!, options));
    return url.toString();
  } catch {
    return href;
  }
}

/**
 * The link that opens a published release in the site: `?__draft=<sha>` on
 * the site's own page. `null` for a value that isn't a release or a URL that
 * doesn't parse.
 */
export function releasePreviewUrl(
  siteUrl: string | null | undefined,
  sha: string,
  path = "/",
): string | null {
  if (!siteUrl || !isReleaseSha(sha)) return null;
  try {
    const url = new URL(path, siteUrl);
    url.searchParams.set("__draft", sha);
    return url.toString();
  } catch {
    return null;
  }
}
