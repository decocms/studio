import { describe, expect, test } from "bun:test";
import {
  buildReportHead,
  isShareSafeImageUrl,
  type ReportSeo,
} from "./report-pages";

/** Pull the `content`/`href` of a tag from a built head block. */
function attr(head: string, re: RegExp): string | null {
  return head.match(re)?.[1] ?? null;
}

const SCREENSHOT = "https://shots.example.com/nike.com/home-desktop.jpg";
const SEO: ReportSeo = {
  brand: "Nike",
  score: 68,
  verdict: "Organic traffic is in free fall.",
  screenshot: SCREENSHOT,
};

describe("isShareSafeImageUrl", () => {
  test("accepts a stable, clean-path https URL", () => {
    expect(isShareSafeImageUrl(SCREENSHOT)).toBe(true);
  });
  test("rejects signed/expiring, http, and empty URLs", () => {
    expect(
      isShareSafeImageUrl(
        "https://s.googleapis.com/x.png?Expires=1&Signature=a",
      ),
    ).toBe(false);
    expect(isShareSafeImageUrl("http://shots.example.com/x.jpg")).toBe(false);
    expect(isShareSafeImageUrl(undefined)).toBe(false);
    expect(isShareSafeImageUrl("not a url")).toBe(false);
  });
});

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

  test("uses the report screenshot as a large summary image (og + twitter)", () => {
    const head = buildReportHead("nike.com", SEO);
    expect(attr(head, /property="og:image" content="([^"]*)"/)).toBe(
      SCREENSHOT,
    );
    expect(attr(head, /name="twitter:image" content="([^"]*)"/)).toBe(
      SCREENSHOT,
    );
    expect(attr(head, /name="twitter:card" content="([^"]*)"/)).toBe(
      "summary_large_image",
    );
    // No dimension claims for an externally-sized screenshot.
    expect(head).not.toContain("og:image:width");
  });

  test("falls back to the designed static card (absolute URL + dims) with no report", () => {
    const head = buildReportHead("nike.com", null);
    const image = attr(head, /property="og:image" content="([^"]*)"/);
    // Absolute — a relative og:image fails on most unfurlers.
    expect(image).toMatch(/^https?:\/\/.+\/report-og-fallback\.png$/);
    expect(head).toContain('property="og:image:width" content="1200"');
    expect(head).toContain('property="og:image:height" content="630"');
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

  test("rejects a signed/expiring screenshot URL as og:image (would 403 in caches)", () => {
    const head = buildReportHead("nike.com", {
      brand: "Nike",
      score: 47,
      screenshot:
        "https://storage.googleapis.com/bucket/shot.png?Expires=1783778625&Signature=abc",
    });
    // Falls back to the stable designed card, never the signed URL.
    expect(head).not.toContain("storage.googleapis.com");
    expect(attr(head, /property="og:image" content="([^"]*)"/)).toMatch(
      /\/report-og-fallback\.png$/,
    );
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
