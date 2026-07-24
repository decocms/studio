import { describe, expect, test } from "bun:test";
import { buildReportHead, type ReportSeo } from "./report-pages";

/** Pull the `content`/`href` of a tag from a built head block. */
function attr(head: string, re: RegExp): string | null {
  return head.match(re)?.[1] ?? null;
}

const SEO: ReportSeo = {
  brand: "Nike",
  score: 68,
  verdict: "Organic traffic is in free fall.",
};

describe("buildReportHead — dynamic report SEO", () => {
  test("title carries brand + real score; description carries the verdict", () => {
    const head = buildReportHead("nike.com", SEO);
    const title = attr(head, /<title>([^<]*)<\/title>/);
    expect(title).toBe("Nike commerce report — 68/100 · decocms");
    const desc = attr(head, /name="description" content="([^"]*)"/);
    expect(desc).toContain("Organic traffic is in free fall.");
    // og + twitter mirror the primary tags.
    expect(attr(head, /property="og:title" content="([^"]*)"/)).toBe(title);
    expect(attr(head, /name="twitter:title" content="([^"]*)"/)).toBe(title);
  });

  test("og:image points at the per-report /og.png card (absolute, large summary)", () => {
    const head = buildReportHead("nike.com", SEO);
    const image = attr(head, /property="og:image" content="([^"]*)"/);
    // Absolute + the rendered per-report card route.
    expect(image).toMatch(/^https?:\/\/.+\/report\/nike\.com\/og\.png$/);
    expect(attr(head, /name="twitter:image" content="([^"]*)"/)).toBe(image);
    expect(attr(head, /name="twitter:card" content="([^"]*)"/)).toBe(
      "summary_large_image",
    );
    expect(head).toContain('property="og:image:width" content="1200"');
    expect(head).toContain('property="og:image:height" content="630"');
  });

  test("still points at /og.png even with no report data (route serves the fallback)", () => {
    const head = buildReportHead("nike.com", null);
    expect(attr(head, /property="og:image" content="([^"]*)"/)).toMatch(
      /\/report\/nike\.com\/og\.png$/,
    );
    // Domain-derived brand + generic score-less title.
    expect(attr(head, /<title>([^<]*)<\/title>/)).toBe(
      "Nike commerce report · decocms",
    );
  });

  test("favicon points at the scanned domain; canonical is absolute + normalized", () => {
    const head = buildReportHead("https://WWW.Nike.com/x", null);
    expect(attr(head, /rel="icon" href="([^"]*)"/)).toContain(
      "domain=nike.com",
    );
    expect(attr(head, /rel="canonical" href="([^"]*)"/)).toMatch(
      /^https?:\/\/.+\/report\/nike\.com$/,
    );
  });

  test("keeps report pages out of the index (noindex, follow)", () => {
    const head = buildReportHead("nike.com", SEO);
    expect(head).toContain('name="robots" content="noindex, follow"');
  });

  test("escapes an HTML-injecting domain param in every field", () => {
    // No `/`, `?`, or `#` — normalizeDomain would otherwise truncate at the
    // first, masking whether esc() actually escapes the payload.
    const malicious = 'evil.com"><svg onload=alert(1)>';
    const head = buildReportHead(malicious, null);
    expect(head).not.toContain('"><svg onload=alert(1)>');
    expect(head).toContain("&quot;&gt;&lt;svg onload=alert(1)&gt;");
  });
});
