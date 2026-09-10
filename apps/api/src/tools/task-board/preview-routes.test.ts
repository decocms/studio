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

  it("drops a backslash-prefixed path `new URL()` would resolve off-origin", () => {
    // `\` becomes `/` inside `new URL(route, previewUrl)`.
    expect(new URL("/\\evil.com", "https://trusted.com").hostname).toBe(
      "evil.com",
    );
    expect(normalizePreviewRoutes(["/\\evil.com", "/ok"])).toEqual(["/ok"]);
  });

  it("drops a tab-smuggled path that resolves to a protocol-relative URL", () => {
    // A stripped tab collapses "/\t/evil.com" into "//evil.com".
    expect(new URL("/\t/evil.com", "https://trusted.com").hostname).toBe(
      "evil.com",
    );
    expect(normalizePreviewRoutes(["/\t/evil.com", "/ok"])).toEqual(["/ok"]);
  });
});
