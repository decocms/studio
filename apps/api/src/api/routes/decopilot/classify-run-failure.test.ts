import { describe, expect, test } from "bun:test";
import {
  classifyRunFailure,
  GENERIC_RUN_FAILURE,
} from "./classify-run-failure";

describe("classifyRunFailure", () => {
  test("the 402 that killed most production runs", () => {
    const real =
      "Error: API Error: 402 This request requires more credits, or fewer " +
      "max_tokens. You requested up to 64000 tokens, but can only afford 47750.";
    expect(classifyRunFailure(real).kind).toBe("credits");
    expect(classifyRunFailure("[CREDITS] out of balance").kind).toBe("credits");
  });

  test("credits beats the generic API-error pattern that also matches", () => {
    // Order in the table decides; the specific kind has to win.
    expect(
      classifyRunFailure("Error: API Error: 402 requires more credits").kind,
    ).toBe("credits");
  });

  test("classifies the other shapes seen in production", () => {
    const cases: Array<[string, string]> = [
      [
        "Error: [SANDBOX_UNREACHABLE] the sandbox stream broke mid-run",
        "sandbox_unreachable",
      ],
      ["Error: cancelled: run cancelled", "cancelled"],
      ["Error: Overloaded.", "overloaded"],
      ["429 Too Many Requests", "overloaded"],
      ["Error: API Error: 500 upstream", "model_error"],
    ];
    for (const [text, kind] of cases) {
      expect(classifyRunFailure(text).kind).toBe(kind);
    }
  });

  test("unrecognized text keeps exactly today's behavior", () => {
    for (const text of ["something new", "", "   ", null, undefined]) {
      expect(classifyRunFailure(text)).toEqual({ ...GENERIC_RUN_FAILURE });
    }
  });

  test("every kind carries a distinct human reason", () => {
    const texts = [
      "requires more credits",
      "[SANDBOX_UNREACHABLE] x",
      "cancelled: run cancelled",
      "Overloaded.",
      "exceeds the maximum context length",
      "API Error: 500 provider",
      "unrecognized",
    ];
    const seen = texts.map((t) => classifyRunFailure(t));
    for (const r of seen) expect(r.reason.length).toBeGreaterThan(10);
    const byKind = new Map(seen.map((r) => [r.kind, r.reason]));
    expect(new Set(byKind.values()).size).toBe(byKind.size);
  });
});
