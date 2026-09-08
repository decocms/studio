import { describe, expect, it } from "bun:test";
import { normalizePreviewRoutes } from "./preview-routes";

describe("normalizePreviewRoutes", () => {
  it("passes absolute paths through, trimmed and deduped", () => {
    expect(
      normalizePreviewRoutes([" /cliente-vip ", "/cliente-vip", "/faq?a=1"]),
    ).toEqual(["/cliente-vip", "/faq?a=1"]);
  });

  it("drops anything that isn't a plain absolute path", () => {
    expect(
      normalizePreviewRoutes([
        "//evil.com",
        "https://evil.com/x",
        "plugins/cliente-vip",
        "",
        "/ok",
      ]),
    ).toEqual(["/ok"]);
  });

  it("distinguishes 'clear it' from 'leave it alone'", () => {
    expect(normalizePreviewRoutes([])).toEqual([]);
    expect(normalizePreviewRoutes(undefined)).toBeUndefined();
  });
});
