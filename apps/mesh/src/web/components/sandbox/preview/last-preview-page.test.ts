import { describe, expect, it } from "bun:test";
import { lastPreviewPageKey, parseLastPreviewPage } from "./last-preview-page";

describe("last-preview-page", () => {
  it("lastPreviewPageKey scopes by org, vm and branch", () => {
    expect(lastPreviewPageKey("acme", "vm-1", "main")).toBe(
      "deco:preview:last-page:acme:vm-1:main",
    );
  });

  it("parseLastPreviewPage round-trips a valid entry", () => {
    const entry = {
      path: "/blog/:slug",
      pageKey: "pages-Blogpost-abc",
      params: { slug: "dicas" },
    };
    expect(parseLastPreviewPage(JSON.stringify(entry))).toEqual(entry);
  });

  it("parseLastPreviewPage defaults missing fields", () => {
    expect(parseLastPreviewPage(JSON.stringify({ path: "/about" }))).toEqual({
      path: "/about",
      pageKey: null,
      params: {},
    });
  });

  it("parseLastPreviewPage rejects malformed values", () => {
    expect(parseLastPreviewPage(null)).toBeNull();
    expect(parseLastPreviewPage("not json")).toBeNull();
    expect(parseLastPreviewPage(JSON.stringify("string"))).toBeNull();
    expect(parseLastPreviewPage(JSON.stringify(["a"]))).toBeNull();
    expect(parseLastPreviewPage(JSON.stringify({ path: 42 }))).toBeNull();
    expect(
      parseLastPreviewPage(JSON.stringify({ path: "no-leading-slash" })),
    ).toBeNull();
  });

  it("parseLastPreviewPage drops non-string param values", () => {
    expect(
      parseLastPreviewPage(
        JSON.stringify({ path: "/b/:slug", params: { slug: "ok", n: 1 } }),
      ),
    ).toEqual({ path: "/b/:slug", pageKey: null, params: { slug: "ok" } });
  });
});
