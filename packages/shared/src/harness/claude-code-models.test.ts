import { describe, expect, test } from "bun:test";
import { isClaudeCodeModel } from "./claude-code-models";

describe("isClaudeCodeModel", () => {
  test("Claude models in each credential's own id shape", () => {
    expect(isClaudeCodeModel("anthropic", "claude-sonnet-5")).toBe(true);
    expect(isClaudeCodeModel("openrouter", "anthropic/claude-opus-5.5")).toBe(
      true,
    );
    expect(isClaudeCodeModel("deco", "anthropic/claude-haiku-5")).toBe(true);
  });

  test("other families, other id shapes and other providers are out", () => {
    expect(isClaudeCodeModel("openrouter", "google/gemini-3-pro")).toBe(false);
    expect(isClaudeCodeModel("openrouter", "claude-sonnet-5")).toBe(false);
    expect(isClaudeCodeModel("anthropic", "anthropic/claude-sonnet-5")).toBe(
      false,
    );
    expect(isClaudeCodeModel("google", "claude-sonnet-5")).toBe(false);
  });
});
