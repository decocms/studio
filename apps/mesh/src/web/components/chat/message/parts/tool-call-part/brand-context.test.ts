import { describe, expect, test } from "bun:test";
import {
  domainHref,
  getColorEntries,
  getFontEntries,
} from "./brand-context.tsx";

describe("domainHref", () => {
  test("adds https:// to a bare domain", () => {
    expect(domainHref("example.com")).toBe("https://example.com/");
  });

  test("keeps an existing https:// domain", () => {
    expect(domainHref("https://example.com")).toBe("https://example.com/");
  });

  test("rejects a javascript: scheme, falling back to about:blank", () => {
    expect(domainHref("javascript:alert(1)")).toBe("about:blank");
  });

  test("rejects a data: scheme, falling back to about:blank", () => {
    expect(domainHref("data:text/html,<script>alert(1)</script>")).toBe(
      "about:blank",
    );
  });

  test("falls back to about:blank on an unparsable URL", () => {
    expect(domainHref("not a url")).toBe("about:blank");
  });
});

describe("getColorEntries", () => {
  test("returns empty array for null/undefined colors", () => {
    expect(getColorEntries(null)).toEqual([]);
    expect(getColorEntries(undefined)).toEqual([]);
  });

  test("filters out empty and non-string values", () => {
    expect(
      getColorEntries({
        primary: "#fff",
        secondary: "",
        accent: "   ",
      }),
    ).toEqual([["primary", "#fff"]]);
  });

  test("keeps all populated color entries", () => {
    expect(getColorEntries({ primary: "#fff", background: "#000" })).toEqual([
      ["primary", "#fff"],
      ["background", "#000"],
    ]);
  });
});

describe("getFontEntries", () => {
  test("returns empty array for null/undefined fonts", () => {
    expect(getFontEntries(null)).toEqual([]);
    expect(getFontEntries(undefined)).toEqual([]);
  });

  test("filters out empty and non-string values", () => {
    expect(getFontEntries({ heading: "Inter", body: "" })).toEqual([
      ["heading", "Inter"],
    ]);
  });

  test("keeps all populated font entries", () => {
    expect(getFontEntries({ heading: "Inter", code: "Mono" })).toEqual([
      ["heading", "Inter"],
      ["code", "Mono"],
    ]);
  });
});
