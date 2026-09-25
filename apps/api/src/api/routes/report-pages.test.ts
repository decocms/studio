import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  buildReportHead,
  createReportPagesRoutes,
  type ReportSeo,
} from "./report-pages";

/** Pull the `content`/`href` of a tag from a built head block. */
function attr(head: string, re: RegExp): string | null {
  return head.match(re)?.[1] ?? null;
}

const SEO: ReportSeo = { brand: "Nike", score: 68 };

describe("buildReportHead — dynamic report SEO", () => {
  test("title carries brand + real score", () => {
    const head = buildReportHead("nike.com", SEO);
    const title = attr(head, /<title>([^<]*)<\/title>/);
    expect(title).toBe("Nike commerce report — 68/100 · decocms");
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

  test("advertises the Markdown mirror next to the canonical page", () => {
    const head = buildReportHead("nike.com", null);
    expect(
      attr(head, /rel="alternate" type="text\/markdown" href="([^"]*)"/),
    ).toMatch(/^https?:\/\/.+\/report\/nike\.com\.md$/);
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

describe("GET /report/:domain.md", () => {
  const app = createReportPagesRoutes(undefined);
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  afterEach(() => fetchSpy.mockRestore());

  const engineReplies = (response: Response) => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);
  };

  test("serves the engine's markdown for the normalized domain", async () => {
    engineReplies(new Response("# Example\n", { status: 200 }));
    const res = await app.request("/WWW.Example.com.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("# Example\n");
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toMatch(
      /\/api\/v2\/public\/diagnostics\/example\.com\/onepager\.md$/,
    );
  });

  test("forwards the reader's language to the engine", async () => {
    engineReplies(new Response("# Example\n", { status: 200 }));
    await app.request("/example.com.md?lang=pt-BR");
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/onepager\.md\?lang=pt-BR$/);
  });

  test("answers 404 when nothing is published", async () => {
    engineReplies(new Response("not_found", { status: 404 }));
    const res = await app.request("/example.com.md");
    expect(res.status).toBe(404);
  });

  test("answers 502 when the engine fails", async () => {
    engineReplies(new Response("boom", { status: 500 }));
    const res = await app.request("/example.com.md");
    expect(res.status).toBe(502);
  });
});
