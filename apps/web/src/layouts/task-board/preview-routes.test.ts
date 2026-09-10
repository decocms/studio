import { describe, expect, it } from "bun:test";
import { previewRouteUrl } from "./preview-routes";

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
