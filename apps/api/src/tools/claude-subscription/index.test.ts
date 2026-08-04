import { describe, expect, test } from "bun:test";
import { normalizeSubscriptionToken } from "./index";

describe("normalizeSubscriptionToken", () => {
  test("accepts a setup-token, trimmed", () => {
    expect(normalizeSubscriptionToken("  sk-ant-oat01-abc \n")).toBe(
      "sk-ant-oat01-abc",
    );
  });

  test("rejects a Console API key — it bills API usage, not the plan", () => {
    expect(() => normalizeSubscriptionToken("sk-ant-api03-xyz")).toThrow(
      /Console API key/,
    );
  });

  test("rejects a token with inner whitespace", () => {
    // A copy/paste that picked up a line wrap would otherwise be stored and
    // fail much later, inside a sandbox, as an opaque auth error.
    expect(() => normalizeSubscriptionToken("sk-ant-oat01 abc")).toThrow(
      /spaces or line breaks/,
    );
  });

  test("rejects whitespace-only input", () => {
    expect(() => normalizeSubscriptionToken("   ")).toThrow(
      /must not be empty/,
    );
  });

  test("accepts an unknown prefix — only Anthropic can validate the token", () => {
    expect(normalizeSubscriptionToken("future-format-token")).toBe(
      "future-format-token",
    );
  });

  test("the rejection never echoes the token back", () => {
    let message = "";
    try {
      normalizeSubscriptionToken("sk-ant-api03-secret");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("secret");
  });
});
