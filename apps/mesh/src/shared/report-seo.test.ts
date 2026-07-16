import { describe, expect, test } from "bun:test";
import {
  brandFromDomain,
  clampText,
  normalizeDomain,
  reportPath,
  reportShareCopy,
} from "./report-seo";

describe("report SEO helpers", () => {
  test("normalizes URL-like route parameters to a domain", () => {
    expect(normalizeDomain(" HTTPS://WWW.Nike.COM/products?q=shoe ")).toBe(
      "nike.com",
    );
  });

  test("builds encoded report paths", () => {
    expect(reportPath("https://www.nike.com/products")).toBe(
      "/report/nike.com",
    );
  });

  test("derives readable share copy with an optional score", () => {
    const brand = brandFromDomain("acme-store.com");
    expect(brand).toBe("Acme Store");
    expect(
      reportShareCopy({ brand, domain: "acme-store.com", score: 72 }).title,
    ).toContain("72/100");
  });

  test("clamps long copy on a word boundary", () => {
    expect(clampText("one two three four", 14)).toBe("one two three…");
  });
});
