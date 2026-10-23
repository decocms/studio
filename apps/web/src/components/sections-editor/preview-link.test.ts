import { describe, expect, it } from "bun:test";
import {
  hasPreviewOptions,
  isReleaseSha,
  releasePreviewUrl,
  withPreviewOptions,
  withPreviewOptionsInDraftUrl,
} from "./preview-link";
import { withForcedVariants } from "./variant-draft-pointer";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const POINTER = "delivery.decocms.com/sites/demo/drafts/d1.json@etag1";

describe("withPreviewOptions", () => {
  it("adds the moment and forced tests to a draft pointer's query, encoded", () => {
    expect(
      withPreviewOptions(POINTER, {
        at: "2026-11-27T00:00:00-03:00",
        tests: { "hero-test": true, "cta test": false },
      }),
    ).toBe(
      "delivery.decocms.com/sites/demo/drafts/d1.json" +
        "?__at=2026-11-27T00%3A00%3A00-03%3A00" +
        "&__test=hero-test%3Don&__test=cta%20test%3Doff@etag1",
    );
  });

  it("replaces what the pointer carried and keeps forced variants", () => {
    const forced = withForcedVariants(POINTER, ["home@sections=1"]);
    const once = withPreviewOptions(forced, { at: "2026-01-01T00:00:00Z" });
    const twice = withPreviewOptions(once, { tests: { a: true } });
    expect(twice).toBe(
      "delivery.decocms.com/sites/demo/drafts/d1.json" +
        "?__variant=home%40sections%3D1&__test=a%3Don@etag1",
    );
    expect(withPreviewOptions(twice, {})).toBe(forced);
  });

  it("puts them after a release's commit SHA", () => {
    expect(withPreviewOptions(SHA, { at: "2026-11-27T00:00:00Z" })).toBe(
      `${SHA}?__at=2026-11-27T00%3A00%3A00Z`,
    );
    expect(withPreviewOptions(`${SHA}?__at=x`, { tests: { t: false } })).toBe(
      `${SHA}?__test=t%3Doff`,
    );
    expect(withPreviewOptions(`${SHA}?__at=x`, {})).toBe(SHA);
  });

  it("leaves anything else as it is", () => {
    expect(withPreviewOptions("off", { at: "2026-01-01T00:00:00Z" })).toBe(
      "off",
    );
  });
});

describe("withPreviewOptionsInDraftUrl", () => {
  const options = { tests: { a: true } };

  it("sets them on the link's draft", () => {
    const href = `https://site.test/p?__draft=${encodeURIComponent(POINTER)}`;
    const next = new URL(withPreviewOptionsInDraftUrl(href, options));
    expect(next.searchParams.get("__draft")).toBe(
      "delivery.decocms.com/sites/demo/drafts/d1.json?__test=a%3Don@etag1",
    );
  });

  it("previews the current release when the link shows the published site", () => {
    for (const href of [
      "https://site.test/p",
      "https://site.test/p?__draft=off",
    ]) {
      const next = new URL(withPreviewOptionsInDraftUrl(href, options, SHA));
      expect(next.searchParams.get("__draft")).toBe(`${SHA}?__test=a%3Don`);
    }
  });

  it("changes nothing without options, or with no release to show", () => {
    const href = "https://site.test/p?__draft=off";
    expect(withPreviewOptionsInDraftUrl(href, {}, SHA)).toBe(href);
    expect(withPreviewOptionsInDraftUrl(href, options, null)).toBe(href);
    expect(withPreviewOptionsInDraftUrl(href, options, "not-a-sha")).toBe(href);
  });
});

describe("helpers", () => {
  it("knows a release SHA and when options are set", () => {
    expect(isReleaseSha(SHA)).toBe(true);
    expect(isReleaseSha(SHA.toUpperCase())).toBe(false);
    expect(isReleaseSha("abc")).toBe(false);
    expect(hasPreviewOptions({})).toBe(false);
    expect(hasPreviewOptions({ tests: {} })).toBe(false);
    expect(hasPreviewOptions({ at: "x" })).toBe(true);
  });

  it("builds the link that opens a published release", () => {
    expect(releasePreviewUrl("https://site.test", SHA)).toBe(
      `https://site.test/?__draft=${SHA}`,
    );
    expect(releasePreviewUrl("https://site.test/", SHA, "/p/1")).toBe(
      `https://site.test/p/1?__draft=${SHA}`,
    );
    expect(releasePreviewUrl(null, SHA)).toBeNull();
    expect(releasePreviewUrl("https://site.test", "main")).toBeNull();
  });
});
