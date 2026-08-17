import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  claudeCodeEnvFromCredential,
  modelClassFromMetadata,
  UnsupportedClaudeCodeProviderError,
} from "./claude-code-env";

const BUDGET = {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: `${CLAUDE_CODE_MAX_OUTPUT_TOKENS}`,
};

describe("claudeCodeEnvFromCredential", () => {
  test("an Anthropic key is used directly", () => {
    expect(
      claudeCodeEnvFromCredential({ providerId: "anthropic", apiKey: "sk-a" }),
    ).toEqual({
      ...BUDGET,
      CLAUDE_CODE_MODEL: "claude-opus-5",
      ANTHROPIC_API_KEY: "sk-a",
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
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
      ...BUDGET,
      CLAUDE_CODE_MODEL: "anthropic/claude-opus-5",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "or-1",
      CLAUDE_CODE_OAUTH_TOKEN: null,
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
      ...BUDGET,
      CLAUDE_CODE_MODEL: "anthropic/claude-opus-5",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "deco-1",
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    });
  });

  test("a linked Claude subscription goes on the CLI's OAuth variable", () => {
    expect(
      claudeCodeEnvFromCredential({
        providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
        apiKey: "sk-ant-oat-1",
      }),
    ).toEqual({
      ...BUDGET,
      CLAUDE_CODE_MODEL: "claude-opus-5",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-1",
      // Both cleared: either one left behind outranks the OAuth token and the
      // run would silently bill the org's API credit instead of the plan.
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });
  });

  test("a key credential clears a previous run's OAuth token", () => {
    for (const providerId of ["anthropic", "openrouter", "deco"]) {
      expect(
        claudeCodeEnvFromCredential({ providerId, apiKey: "k" })
          .CLAUDE_CODE_OAUTH_TOKEN,
      ).toBeNull();
    }
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

  test("every shape bounds the per-response output budget", () => {
    // Unbounded, the SDK asks the model's own 64k ceiling and OpenRouter 402s.
    for (const providerId of [
      "anthropic",
      "openrouter",
      "deco",
      CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    ]) {
      expect(
        claudeCodeEnvFromCredential({ providerId, apiKey: "k" })
          .CLAUDE_CODE_MAX_OUTPUT_TOKENS,
      ).toBe(`${CLAUDE_CODE_MAX_OUTPUT_TOKENS}`);
    }
    expect(CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeLessThan(64_000);
  });

  test("the reviewer class runs a cheaper model on every provider", () => {
    expect(
      claudeCodeEnvFromCredential(
        { providerId: "anthropic", apiKey: "sk-a" },
        "reviewer",
      ).CLAUDE_CODE_MODEL,
    ).toBe("claude-sonnet-5");
    expect(
      claudeCodeEnvFromCredential(
        { providerId: "openrouter", apiKey: "or-1" },
        "reviewer",
      ).CLAUDE_CODE_MODEL,
    ).toBe("anthropic/claude-sonnet-5");
    expect(
      claudeCodeEnvFromCredential(
        { providerId: "deco", apiKey: "deco-1" },
        "reviewer",
      ).CLAUDE_CODE_MODEL,
    ).toBe("anthropic/claude-sonnet-5");
    expect(
      claudeCodeEnvFromCredential(
        { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, apiKey: "sk-ant-oat-1" },
        "reviewer",
      ).CLAUDE_CODE_MODEL,
    ).toBe("claude-sonnet-5");
  });

  test("the class changes only the model — credentials are untouched", () => {
    const { CLAUDE_CODE_MODEL: _builder, ...builderRest } =
      claudeCodeEnvFromCredential({ providerId: "openrouter", apiKey: "or-1" });
    const { CLAUDE_CODE_MODEL: _reviewer, ...reviewerRest } =
      claudeCodeEnvFromCredential(
        { providerId: "openrouter", apiKey: "or-1" },
        "reviewer",
      );
    expect(reviewerRest).toEqual(builderRest);
  });

  test("omitting the class keeps the model every run had before", () => {
    expect(
      claudeCodeEnvFromCredential({ providerId: "openrouter", apiKey: "or-1" })
        .CLAUDE_CODE_MODEL,
    ).toBe("anthropic/claude-opus-5");
  });

  test("modelClassFromMetadata only trusts the exact reviewer value", () => {
    expect(modelClassFromMetadata("reviewer")).toBe("reviewer");
    for (const value of [undefined, "", "default", "Reviewer", "qa", "cheap"]) {
      expect(modelClassFromMetadata(value)).toBe("default");
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
