import { describe, expect, test } from "bun:test";
import {
  claudeCodeEnvFromCredential,
  UnsupportedClaudeCodeProviderError,
} from "./claude-code-env";

describe("claudeCodeEnvFromCredential", () => {
  test("an Anthropic key is used directly", () => {
    expect(
      claudeCodeEnvFromCredential({ providerId: "anthropic", apiKey: "sk-a" }),
    ).toEqual({
      CLAUDE_CODE_MODEL: "claude-opus-5",
      ANTHROPIC_API_KEY: "sk-a",
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });
  });

  test("an Anthropic credential keeps its own base URL override", () => {
    expect(
      claudeCodeEnvFromCredential({
        providerId: "anthropic",
        apiKey: "sk-a",
        baseUrl: "https://proxy.internal",
      }).ANTHROPIC_BASE_URL,
    ).toBe("https://proxy.internal");
  });

  test("OpenRouter points at the Anthropic-compatible endpoint", () => {
    expect(
      claudeCodeEnvFromCredential({ providerId: "openrouter", apiKey: "or-1" }),
    ).toEqual({
      CLAUDE_CODE_MODEL: "anthropic/claude-opus-5",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "or-1",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    });
  });

  test("OpenRouter's API key is emptied, never left absent", () => {
    // A leftover non-empty ANTHROPIC_API_KEY outranks the auth token, so the
    // run would send an OpenRouter key to Anthropic and fail on auth.
    const env = claudeCodeEnvFromCredential({
      providerId: "openrouter",
      apiKey: "or-1",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect("ANTHROPIC_API_KEY" in env).toBe(true);
  });

  test("each shape clears the other's variables", () => {
    // Same sandbox, credential switched between runs: the stale variable must
    // be deleted (null), not merely overwritten alongside the new one.
    expect(
      claudeCodeEnvFromCredential({ providerId: "anthropic", apiKey: "sk-a" })
        .ANTHROPIC_AUTH_TOKEN,
    ).toBeNull();
    expect(
      claudeCodeEnvFromCredential({ providerId: "openrouter", apiKey: "or-1" })
        .ANTHROPIC_API_KEY,
    ).toBe("");
  });

  test("a deco key takes the OpenRouter path — it is an OpenRouter key", () => {
    expect(
      claudeCodeEnvFromCredential({ providerId: "deco", apiKey: "deco-1" }),
    ).toEqual({
      CLAUDE_CODE_MODEL: "anthropic/claude-opus-5",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "deco-1",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    });
  });

  test("any other provider fails loudly, with the provider named", () => {
    for (const providerId of ["google", "openai", "future"]) {
      expect(() =>
        claudeCodeEnvFromCredential({ providerId, apiKey: "k" }),
      ).toThrow(UnsupportedClaudeCodeProviderError);
      expect(() =>
        claudeCodeEnvFromCredential({ providerId, apiKey: "k" }),
      ).toThrow(new RegExp(providerId));
    }
  });

  test("the error never contains the key", () => {
    let message = "";
    try {
      claudeCodeEnvFromCredential({ providerId: "google", apiKey: "secret-k" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("secret-k");
  });
});
