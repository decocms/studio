import { describe, expect, test } from "bun:test";
import { toDeck, type PublicReportResponse } from "./to-deck.ts";

const meta = {
  url: "https://example.com/",
  domain: "example.com",
  brand: "Example",
  initial: "E",
  faviconUrl: "https://example.com/favicon.ico",
};

function section(position: number, props: unknown) {
  return { section_type: "generic", position, props };
}

function response(
  sections: PublicReportResponse["sections"],
  scannedAt: string | null = "2026-07-28T12:00:00.000Z",
): PublicReportResponse {
  return {
    url: meta.url,
    scope: "public",
    scanned_at: scannedAt,
    meta,
    summary: null,
    sections,
    results: [],
  };
}

const COVER = {
  key: "cover",
  title: "Cover",
  headline: "Your store is losing customers",
  template: { template: "cover", score: { value: 22 } },
};
const CHAPTER_ONE = {
  key: "porta",
  title: "The front door is shut",
  headline: "The front door is shut",
  template: { template: "stats", stats: [{ value: "3", label: "errors" }] },
};
const CHAPTER_TWO = {
  key: "paginas",
  title: "Pages Google can't read",
  headline: "Pages Google can't read",
  template: { template: "stats", stats: [{ value: "9", label: "pages" }] },
};
const CTA = {
  key: "cta",
  title: "Talk to us",
  headline: "Talk to us",
  template: { template: "cta" },
};

describe("toDeck", () => {
  test("builds meta.toc from the content slides, in order", () => {
    const { deck } = toDeck(
      response([
        section(0, COVER),
        section(1, CHAPTER_ONE),
        section(2, CHAPTER_TWO),
        section(3, CTA),
      ]),
    );

    expect(deck.meta.toc).toEqual([
      { key: "porta", title: "The front door is shut" },
      { key: "paginas", title: "Pages Google can't read" },
    ]);
  });

  test("the toc survives truncating slides to the cover", () => {
    // What `GET /api/_reports/site/:domain` does for a logged-out caller: only
    // `slides` is cut, so the cover can still name every chapter.
    const { deck } = toDeck(
      response([section(0, COVER), section(1, CHAPTER_ONE), section(2, CTA)]),
    );
    const truncated = { ...deck, slides: deck.slides.slice(0, 1) };

    expect(truncated.slides).toHaveLength(1);
    expect(truncated.meta.toc).toEqual([
      { key: "porta", title: "The front door is shut" },
    ]);
  });

  test("a deck of only cover + cta has an empty toc", () => {
    const { deck } = toDeck(response([section(0, COVER), section(1, CTA)]));
    expect(deck.meta.toc).toEqual([]);
  });

  test("dropped slides stay out of the toc", () => {
    // `stats` with an empty array violates the contract, so the slide is
    // dropped — a chapter the cover must not promise.
    const { deck, drops } = toDeck(
      response([
        section(0, COVER),
        section(1, CHAPTER_ONE),
        section(2, {
          key: "broken",
          title: "Broken",
          headline: "Broken",
          template: { template: "stats", stats: [] },
        }),
      ]),
    );

    expect(drops).toHaveLength(1);
    expect(deck.meta.toc?.map((entry) => entry.key)).toEqual(["porta"]);
  });

  test("carries the scan timestamp onto meta", () => {
    const { deck } = toDeck(response([section(0, COVER)]));
    expect(deck.meta.scannedAt).toBe("2026-07-28T12:00:00.000Z");

    const { deck: undated } = toDeck(response([section(0, COVER)], null));
    expect(undated.meta.scannedAt).toBeNull();
  });
});
