/**
 * Pull-request identity extraction.
 *
 * Every PR-open scenario collapses to the same primitive: find a GitHub PR URL
 * in a string. The GitHub MCP `create_pull_request` result (a minimal
 * `{ id, url }`, or a `{ number, html_url }`, or plain text), `gh pr create`
 * stdout (prints the html URL), and a raw `curl -X POST …/pulls` response body
 * (JSON with `html_url` + api `url`) all embed one. So we stringify whatever we
 * have and scan it — no per-shape branching.
 */

export interface ExtractedPr {
  /** Canonical html URL — the display + dedup key. */
  url: string;
  number: number;
  owner: string;
  repo: string;
}

// Two forms, tried html-first so the human-facing URL wins over the API URL
// when a curl response carries both. `[^/\s"']+` stops each segment at the next
// slash/quote/space, so a trailing `)`/`.` in prose or a JSON quote never leaks
// in; the number's `\d+` stops at any non-digit. Both are linear (no nested
// quantifiers) — safe to run on large stdout.
const HTML_PR = /https?:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+)\/pull\/(\d+)/;
const API_PR =
  /https?:\/\/api\.github\.com\/repos\/([^/\s"']+)\/([^/\s"']+)\/pulls\/(\d+)/;

// ponytail: cap the scan. A single linear regex is fine on big input, but a
// verbose `curl -v` dump can be megabytes — the PR URL, when present, is near
// the top (gh) or in the response body. 200KB covers both without scanning a
// whole log. Raise if a real payload ever buries the URL deeper.
const MAX_SCAN = 200_000;

function build(m: RegExpExecArray): ExtractedPr {
  const owner = m[1]!;
  const repo = m[2]!;
  const number = Number(m[3]);
  return {
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

/** Find the first GitHub PR URL in a string, or null. */
export function extractPrFromText(text: string): ExtractedPr | null {
  const s = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const html = HTML_PR.exec(s);
  if (html && Number(html[3]) > 0) return build(html);
  const api = API_PR.exec(s);
  if (api && Number(api[3]) > 0) return build(api);
  return null;
}

/** Stringify any tool result / bash output and scan it for a PR URL. */
export function extractPrFromValue(value: unknown): ExtractedPr | null {
  if (value == null) return null;
  if (typeof value === "string") return extractPrFromText(value);
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    return null;
  }
  return s ? extractPrFromText(s) : null;
}
