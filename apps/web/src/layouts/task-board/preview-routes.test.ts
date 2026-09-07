import { describe, expect, it } from "bun:test";
import { parsePreviewRoutes, previewRouteUrl } from "./preview-routes";

describe("parsePreviewRoutes", () => {
  it("reads the bullet list under a bare label", () => {
    expect(
      parsePreviewRoutes(
        "Adds the landing page.\n\nPreview routes:\n- /cliente-vip\n- `/cliente-vip/faq`\n",
      ),
    ).toEqual(["/cliente-vip", "/cliente-vip/faq"]);
  });

  it("reads paths off the label's own line, as runs already write them", () => {
    // Verbatim shape from an existing PR body, which predates the block.
    expect(
      parsePreviewRoutes(
        "Builds the landing page.\n\n**Route:** `/cliente-vip` — [Figma](https://www.figma.com/design/x)\n\n## Sections\n\nHero, FAQ accordion.",
      ),
    ).toEqual(["/cliente-vip"]);
  });

  it("collects every label in the body and dedupes", () => {
    expect(parsePreviewRoutes("Route: /a\n\nRoutes: `/b`, `/a`\n")).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("stops a list at the first non-bullet line", () => {
    expect(
      parsePreviewRoutes("Routes:\n- /a\n\n- /never\nNotes:\n- something"),
    ).toEqual(["/a"]);
  });

  it("ignores prose without paths, unlabeled paths and protocol-relative hosts", () => {
    expect(parsePreviewRoutes("just a description with /a in it")).toEqual([]);
    expect(parsePreviewRoutes(null)).toEqual([]);
    expect(parsePreviewRoutes("Route: not a path")).toEqual([]);
    expect(parsePreviewRoutes("Routes: //evil.com /ok")).toEqual(["/ok"]);
    // A relative file path is not a route.
    expect(parsePreviewRoutes("Route: plugins/cliente-vip")).toEqual([]);
  });
});

describe("previewRouteUrl", () => {
  it("keeps the preview origin and replaces the path", () => {
    expect(previewRouteUrl("https://pr-1.deno.dev/", "/cliente-vip")).toBe(
      "https://pr-1.deno.dev/cliente-vip",
    );
    expect(previewRouteUrl("https://pr-1.deno.dev/old", "/new?a=1")).toBe(
      "https://pr-1.deno.dev/new?a=1",
    );
  });
});
