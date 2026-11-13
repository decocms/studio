import { describe, expect, test } from "bun:test";
import { FeedbackFields } from "./feedback-input";

describe("feedback fields", () => {
  test("trims messages and removes URL query credentials and fragments", () => {
    expect(
      FeedbackFields.parse({
        message: " hello ",
        pageUrl: "https://example.com/chat?token=secret#private",
      }),
    ).toEqual({
      kind: "feedback",
      message: "hello",
      pageUrl: "https://example.com/chat",
    });
  });
  test("accepts problem reports and rejects unknown kinds", () => {
    const base = { message: "broken", pageUrl: "https://example.com" };
    expect(FeedbackFields.parse({ ...base, kind: "problem" }).kind).toBe(
      "problem",
    );
    for (const kind of ["", "bug", "PROBLEM"]) {
      expect(FeedbackFields.safeParse({ ...base, kind }).success).toBe(false);
    }
  });
  test("rejects empty, oversized and credential-bearing input", () => {
    for (const message of ["", "  ", "x".repeat(10_001)]) {
      expect(
        FeedbackFields.safeParse({ message, pageUrl: "https://example.com" })
          .success,
      ).toBe(false);
    }
    for (const pageUrl of [
      "javascript:alert(1)",
      "https://user:password@example.com",
      "not a URL",
    ]) {
      expect(
        FeedbackFields.safeParse({ message: "hello", pageUrl }).success,
      ).toBe(false);
    }
  });
});
