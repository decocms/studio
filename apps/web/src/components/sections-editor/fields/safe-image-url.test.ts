import { describe, expect, it } from "bun:test";
import { isSafeImageUrl, safeImageSrc } from "./safe-image-url";

describe("isSafeImageUrl", () => {
  it("accepts http and https", () => {
    expect(isSafeImageUrl("https://cdn.example.com/a.png")).toBe(true);
    expect(isSafeImageUrl("http://cdn.example.com/a.png")).toBe(true);
  });

  it("accepts a relative path, which cannot leave the origin", () => {
    expect(isSafeImageUrl("/assets/a.png")).toBe(true);
    expect(isSafeImageUrl("a.png")).toBe(true);
    expect(isSafeImageUrl("../a.png")).toBe(true);
  });

  it("accepts an inline image payload", () => {
    expect(isSafeImageUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isSafeImageUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(
      true,
    );
  });

  it("rejects the schemes that can execute", () => {
    expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeImageUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeImageUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
  });

  it("ignores surrounding whitespace rather than letting it smuggle a scheme", () => {
    expect(isSafeImageUrl("  javascript:alert(1)  ")).toBe(false);
    expect(isSafeImageUrl("  https://cdn.example.com/a.png ")).toBe(true);
  });

  it("rejects an empty value — there is nothing to render", () => {
    expect(isSafeImageUrl("")).toBe(false);
    expect(isSafeImageUrl("   ")).toBe(false);
  });
});

describe("safeImageSrc", () => {
  it("reduces an unsafe scheme to an empty string", () => {
    expect(safeImageSrc("javascript:alert(1)")).toBe("");
    expect(safeImageSrc("data:text/html,<script>alert(1)</script>")).toBe("");
  });

  it("passes an inline image through untouched", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(safeImageSrc(png)).toBe(png);
  });

  it("returns the parsed href for an absolute URL", () => {
    expect(safeImageSrc("https://cdn.example.com/a.png?quality=high")).toBe(
      "https://cdn.example.com/a.png?quality=high",
    );
  });

  it("keeps a relative path, encoded", () => {
    expect(safeImageSrc("/assets/a b.png")).toBe("/assets/a%20b.png");
  });

  it("is empty for an empty value", () => {
    expect(safeImageSrc("   ")).toBe("");
  });
});
