import { describe, expect, test } from "bun:test";
import { joinCheckOutput } from "./check-run-output";

describe("joinCheckOutput", () => {
  test("joins summary and text with a blank line", () => {
    expect(
      joinCheckOutput({
        summary: "**Verdict:** pass",
        text: "| step |\n|---|",
      }),
    ).toBe("**Verdict:** pass\n\n| step |\n|---|");
  });

  test("returns summary alone when text is empty", () => {
    expect(joinCheckOutput({ summary: "only summary", text: null })).toBe(
      "only summary",
    );
  });

  test("returns text alone when summary is empty", () => {
    expect(joinCheckOutput({ summary: "   ", text: "only text" })).toBe(
      "only text",
    );
  });

  test("returns empty string when both are missing/whitespace", () => {
    expect(joinCheckOutput({ summary: "  ", text: "" })).toBe("");
    expect(joinCheckOutput({})).toBe("");
    expect(joinCheckOutput(null)).toBe("");
    expect(joinCheckOutput(undefined)).toBe("");
  });
});
