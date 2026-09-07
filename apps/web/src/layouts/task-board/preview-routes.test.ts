import { describe, expect, it } from "bun:test";
import { parsePreviewRoutes, previewRouteUrl } from "./preview-routes";

describe("parsePreviewRoutes", () => {
  it("reads the bullet list under the heading", () => {
    expect(
      parsePreviewRoutes(
        "Adds the landing page.\n\nPreview routes:\n- /cliente-vip\n- /cliente-vip/faq\n",
      ),
    ).toEqual(["/cliente-vip", "/cliente-vip/faq"]);
  });

  it("stops at the first non-route line and dedupes", () => {
    expect(
      parsePreviewRoutes(
        "Preview routes:\n- /a\n- /a\n\n- /never\nNotes:\n- something",
      ),
    ).toEqual(["/a"]);
  });

  it("ignores bodies without the block, prose bullets and protocol-relative paths", () => {
    expect(parsePreviewRoutes("just a description")).toEqual([]);
    expect(parsePreviewRoutes(null)).toEqual([]);
    expect(parsePreviewRoutes("Preview routes:\n- not a path")).toEqual([]);
    expect(parsePreviewRoutes("Preview routes:\n- //evil.com\n- /ok")).toEqual([
      "/ok",
    ]);
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
