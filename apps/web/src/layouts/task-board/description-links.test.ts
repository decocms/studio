import { describe, expect, it } from "bun:test";
import { extractDescriptionLinks } from "./description-links";

describe("extractDescriptionLinks", () => {
  it("returns nothing for empty input", () => {
    expect(extractDescriptionLinks("")).toEqual([]);
  });

  it("finds bare URLs and labels them with themselves", () => {
    expect(
      extractDescriptionLinks("see https://example.com/a for details"),
    ).toEqual([
      { url: "https://example.com/a", label: "https://example.com/a" },
    ]);
  });

  it("uses the markdown link text as the label", () => {
    expect(
      extractDescriptionLinks("[the spec](https://example.com/spec)"),
    ).toEqual([{ url: "https://example.com/spec", label: "the spec" }]);
  });

  it("skips embedded images — they are content, not outbound links", () => {
    expect(
      extractDescriptionLinks(
        "![screenshot](https://studio.test/api/acme/fs/uploads/read?path=a.png)",
      ),
    ).toEqual([]);
  });

  it("keeps a real link that sits next to an image", () => {
    const links = extractDescriptionLinks(
      "![shot](https://cdn.test/s.png)\n\n[repro](https://example.com/issue/1)",
    );
    expect(links).toEqual([
      { url: "https://example.com/issue/1", label: "repro" },
    ]);
  });

  it("dedupes a URL that appears both bare and as a markdown link", () => {
    const links = extractDescriptionLinks(
      "[docs](https://example.com/x) and again https://example.com/x",
    );
    expect(links).toEqual([{ url: "https://example.com/x", label: "docs" }]);
  });

  it("falls back to the URL when the markdown label is blank", () => {
    expect(extractDescriptionLinks("[](https://example.com/y)")).toEqual([
      { url: "https://example.com/y", label: "https://example.com/y" },
    ]);
  });

  it("ignores a markdown link to a non-http target", () => {
    expect(extractDescriptionLinks("[local](/settings)")).toEqual([]);
  });
});
