import { describe, it, expect } from "bun:test";
import { truncateString } from "./truncate-string";

describe("truncateString", () => {
  it("should return short strings unchanged", () => {
    const s = JSON.stringify({ hello: "world" });
    expect(truncateString(s, 1024)).toBe(s);
  });

  it("should truncate strings exceeding maxBytes", () => {
    const s = "x".repeat(200);
    const result = truncateString(s, 100);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100);
    expect(result).toContain("... [TRUNCATED]");
  });

  it("should handle exact boundary without truncation", () => {
    const s = JSON.stringify({ a: 1 });
    const len = Buffer.byteLength(s, "utf8");
    expect(truncateString(s, len)).toBe(s);
  });

  it("should handle empty string", () => {
    expect(truncateString("", 100)).toBe("");
  });

  it("should not split multi-byte UTF-8 characters", () => {
    // Each emoji is 4 bytes in UTF-8
    const s = "\u{1F600}".repeat(50); // 200 bytes
    const result = truncateString(s, 100);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100);
    // Verify no partial character by re-encoding
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
  });

  it("should use default maxBytes of 64KB", () => {
    const s = "x".repeat(100_000);
    const result = truncateString(s);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(65_536);
    expect(result).toContain("... [TRUNCATED]");
  });

  it("should use most of the budget (not wastefully small)", () => {
    const s = "x".repeat(200);
    const result = truncateString(s, 100);
    // Should use at least 50% of budget
    expect(Buffer.byteLength(result, "utf8")).toBeGreaterThan(50);
  });
});
