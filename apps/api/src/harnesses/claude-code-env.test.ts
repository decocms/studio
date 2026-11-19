import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_TIER } from "@decocms/shared/organization/schema";
import {
  pickSimpleModeDefaults,
  SMART_MODEL_PREFERENCES,
  THINKING_MODEL_PREFERENCES,
  type AiProviderKey,
  type AiProviderModel,
} from "@decocms/shared/sdk";
import {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  claudeCodeEnvFromCredential,
  claudeSubscriptionChatModel,
  copilotModelId,
  GITHUB_COPILOT_PROVIDER_ID,
  modelClassFromMetadata,
  UnsupportedClaudeCodeProviderError,
} from "./claude-code-env";

const BUDGET = {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: `${CLAUDE_CODE_MAX_OUTPUT_TOKENS}`,
  CLAUDE_CODE_MAX_TURNS: null,
  CLAUDE_CODE_EFFORT: "medium",
  ENABLE_TOOL_SEARCH: "1",
  FORCE_PROMPT_CACHING_5M: "1",
  ANTHROPIC_CUSTOM_HEADERS: null,
};

describe("claudeCodeEnvFromCredential", () => {
  test("an Anthropic key is used directly", () => {
    expect(
      claudeCodeEnvFromCredential({ providerId: "anthropic", apiKey: "sk-a" }),
    ).toEqual({
      ...BUDGET,
      CLAUDE_CODE_MODEL: "claude-opus-5-5",
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
      CLAUDE_CODE_MODEL: "anthropic/claude-opus-5.5",
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
      CLAUDE_CODE_MODEL: "anthropic/claude-opus-5.5",
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
      CLAUDE_CODE_MODEL: "claude-opus-5-5",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-1",
      // Both cleared: either one left behind outranks the OAuth token and the
      // run would silently bill the org's API credit instead of the plan.
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    });
  });

  test("a linked Copilot token is a bearer against Copilot's endpoint", () => {
    expect(
      claudeCodeEnvFromCredential({
        providerId: GITHUB_COPILOT_PROVIDER_ID,
        apiKey: "github_pat_1",
      }),
    ).toEqual({
      ...BUDGET,
      CLAUDE_CODE_MODEL: "claude-sonnet-5.5",
      CLAUDE_CODE_EFFORT: "high",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "github_pat_1",
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: "https://api.githubcopilot.com",
      ANTHROPIC_CUSTOM_HEADERS: "Copilot-Integration-Id: copilot-developer-cli",
    });
  });

  test("a Copilot chat keeps the chosen Claude model in Copilot's id form", () => {
    const model = (chosen: string) =>
      claudeCodeEnvFromCredential(
        { providerId: GITHUB_COPILOT_PROVIDER_ID, apiKey: "k" },
        "chat",
        chosen,
      ).CLAUDE_CODE_MODEL;
    expect(model("claude-opus-5-5")).toBe("claude-opus-5.5");
    expect(model("anthropic/claude-sonnet-5.5")).toBe("claude-sonnet-5.5");
    expect(model("gpt-5")).toBe("claude-sonnet-5.5");
  });

  test("copilotModelId leaves single-number versions alone", () => {
    expect(copilotModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(copilotModelId("anthropic/claude-haiku-4.5")).toBe(
      "claude-haiku-4.5",
    );
    expect(copilotModelId("openai/gpt-5")).toBeNull();
  });

  test("a key credential clears a previous run's OAuth token", () => {
    for (const providerId of [
      "anthropic",
      "openrouter",
      "deco",
      GITHUB_COPILOT_PROVIDER_ID,
    ]) {
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

  test("the reviewer class runs Sonnet 5.5 on every provider", () => {
    expect(
      claudeCodeEnvFromCredential(
        { providerId: "anthropic", apiKey: "sk-a" },
        "reviewer",
      ).CLAUDE_CODE_MODEL,
    ).toBe("claude-sonnet-5-5");
    expect(
      claudeCodeEnvFromCredential(
        { providerId: "openrouter", apiKey: "or-1" },
        "reviewer",
      ).CLAUDE_CODE_MODEL,
    ).toBe("anthropic/claude-sonnet-5.5");
    expect(
      claudeCodeEnvFromCredential(
        { providerId: "deco", apiKey: "deco-1" },
        "reviewer",
      ).CLAUDE_CODE_MODEL,
    ).toBe("anthropic/claude-sonnet-5.5");
    expect(
      claudeCodeEnvFromCredential(
        { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, apiKey: "sk-ant-oat-1" },
        "reviewer",
      ).CLAUDE_CODE_MODEL,
    ).toBe("claude-sonnet-5-5");
    expect(
      claudeCodeEnvFromCredential(
        { providerId: GITHUB_COPILOT_PROVIDER_ID, apiKey: "copilot-token" },
        "reviewer",
      ).CLAUDE_CODE_MODEL,
    ).toBe("claude-sonnet-5.5");
  });

  test("the class changes only the model, the turn cap and the effort — credentials are untouched", () => {
    const {
      CLAUDE_CODE_MODEL: _builder,
      CLAUDE_CODE_MAX_TURNS: _builderTurns,
      CLAUDE_CODE_EFFORT: _builderEffort,
      ...builderRest
    } = claudeCodeEnvFromCredential({
      providerId: "openrouter",
      apiKey: "or-1",
    });
    const {
      CLAUDE_CODE_MODEL: _reviewer,
      CLAUDE_CODE_MAX_TURNS: _reviewerTurns,
      CLAUDE_CODE_EFFORT: _reviewerEffort,
      ...reviewerRest
    } = claudeCodeEnvFromCredential(
      { providerId: "openrouter", apiKey: "or-1" },
      "reviewer",
    );
    expect(reviewerRest).toEqual(builderRest);
  });

  test("only the reviewer is turn-capped, and every shape carries the cap", () => {
    for (const credential of [
      { providerId: "anthropic", apiKey: "sk-a" },
      { providerId: "openrouter", apiKey: "or-1" },
      { providerId: "deco", apiKey: "deco-1" },
      { providerId: CLAUDE_SUBSCRIPTION_PROVIDER_ID, apiKey: "sk-ant-oat-1" },
    ]) {
      expect(
        claudeCodeEnvFromCredential(credential, "reviewer")
          .CLAUDE_CODE_MAX_TURNS,
      ).toBe("60");
      // `null` deletes a cap a prior reviewer run left on this sandbox.
      expect(
        claudeCodeEnvFromCredential(credential, "default")
          .CLAUDE_CODE_MAX_TURNS,
      ).toBeNull();
    }
  });

  test("effort follows the model the run ends up on, not its class", () => {
    const run = (
      providerId: string,
      modelClass: "default" | "chat" | "reviewer" | "conflict",
      chosen?: string,
    ) => {
      const env = claudeCodeEnvFromCredential(
        { providerId, apiKey: "k" },
        modelClass,
        chosen,
      );
      return [env.CLAUDE_CODE_MODEL, env.CLAUDE_CODE_EFFORT];
    };
    for (const providerId of ["anthropic", CLAUDE_SUBSCRIPTION_PROVIDER_ID]) {
      expect(run(providerId, "default")).toEqual(["claude-opus-5-5", "medium"]);
      expect(run(providerId, "chat")).toEqual(["claude-opus-5-5", "medium"]);
      expect(run(providerId, "reviewer")).toEqual([
        "claude-sonnet-5-5",
        "high",
      ]);
      expect(run(providerId, "conflict")).toEqual([
        "claude-sonnet-5-5",
        "high",
      ]);
    }
    for (const providerId of ["openrouter", "deco"]) {
      expect(run(providerId, "default")[1]).toBe("medium");
      expect(run(providerId, "chat")[1]).toBe("medium");
      expect(run(providerId, "reviewer")).toEqual([
        "anthropic/claude-sonnet-5.5",
        "high",
      ]);
      expect(run(providerId, "conflict")[1]).toBe("high");
    }
  });

  test("a chat's picked model sets its effort", () => {
    const picked = (providerId: string, chosen: string) => {
      const env = claudeCodeEnvFromCredential(
        { providerId, apiKey: "k" },
        "chat",
        chosen,
      );
      return [env.CLAUDE_CODE_MODEL, env.CLAUDE_CODE_EFFORT];
    };
    expect(picked("anthropic", "claude-sonnet-5-5")).toEqual([
      "claude-sonnet-5-5",
      "high",
    ]);
    expect(picked("anthropic", "claude-sonnet-4-6")).toEqual([
      "claude-sonnet-4-6",
      "high",
    ]);
    expect(picked("anthropic", "claude-opus-4-8")).toEqual([
      "claude-opus-4-8",
      "medium",
    ]);
    expect(picked("anthropic", "claude-haiku-4-5")).toEqual([
      "claude-haiku-4-5",
      "medium",
    ]);
    expect(picked("deco", "anthropic/claude-sonnet-5.5")).toEqual([
      "anthropic/claude-sonnet-5.5",
      "high",
    ]);
    expect(picked("openrouter", "anthropic/claude-opus-5.5")).toEqual([
      "anthropic/claude-opus-5.5",
      "medium",
    ]);
    expect(picked("openrouter", "anthropic/claude-haiku-4.5")).toEqual([
      "anthropic/claude-haiku-4.5",
      "medium",
    ]);
    expect(picked("openrouter", "google/gemini-3-pro")).toEqual([
      "anthropic/claude-opus-5.5",
      "medium",
    ]);
  });

  test("Copilot runs take the effort of their Copilot-form model", () => {
    const copilot = (
      modelClass: "default" | "chat" | "reviewer" | "conflict",
      chosen?: string,
    ) => {
      const env = claudeCodeEnvFromCredential(
        { providerId: GITHUB_COPILOT_PROVIDER_ID, apiKey: "t" },
        modelClass,
        chosen,
      );
      return [env.CLAUDE_CODE_MODEL, env.CLAUDE_CODE_EFFORT];
    };
    for (const modelClass of [
      "default",
      "chat",
      "reviewer",
      "conflict",
    ] as const) {
      expect(copilot(modelClass)).toEqual(["claude-sonnet-5.5", "high"]);
    }
    expect(copilot("chat", "claude-opus-5-5")).toEqual([
      "claude-opus-5.5",
      "medium",
    ]);
    expect(copilot("chat", "anthropic/claude-haiku-4.5")).toEqual([
      "claude-haiku-4.5",
      "medium",
    ]);
  });

  test("the chat's chosen Claude model sets CLAUDE_CODE_MODEL", () => {
    const model = (providerId: string, chosen: string) =>
      claudeCodeEnvFromCredential({ providerId, apiKey: "k" }, "chat", chosen)
        .CLAUDE_CODE_MODEL;
    expect(model("anthropic", "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(model("openrouter", "anthropic/claude-haiku-5")).toBe(
      "anthropic/claude-haiku-5",
    );
    expect(model("deco", "anthropic/claude-sonnet-5")).toBe(
      "anthropic/claude-sonnet-5",
    );
    expect(model(CLAUDE_SUBSCRIPTION_PROVIDER_ID, "claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    );
  });

  test("a chosen model the CLI cannot run on that credential keeps the chat default", () => {
    const model = (providerId: string, chosen: string) =>
      claudeCodeEnvFromCredential({ providerId, apiKey: "k" }, "chat", chosen)
        .CLAUDE_CODE_MODEL;
    expect(model("openrouter", "google/gemini-3-pro")).toBe(
      "anthropic/claude-opus-5.5",
    );
    expect(model("anthropic", "anthropic/claude-sonnet-5")).toBe(
      "claude-opus-5-5",
    );
    expect(
      model(CLAUDE_SUBSCRIPTION_PROVIDER_ID, "anthropic/claude-sonnet-5"),
    ).toBe("claude-opus-5-5");
  });

  test("a chat with no pick runs the builder's model, except on Copilot", () => {
    const model = (providerId: string) =>
      claudeCodeEnvFromCredential({ providerId, apiKey: "k" }, "chat")
        .CLAUDE_CODE_MODEL;
    expect(model("anthropic")).toBe("claude-opus-5-5");
    expect(model(CLAUDE_SUBSCRIPTION_PROVIDER_ID)).toBe("claude-opus-5-5");
    expect(model("openrouter")).toBe("anthropic/claude-opus-5.5");
    expect(model("deco")).toBe("anthropic/claude-opus-5.5");
    // Copilot gates Opus per account; an unavailable model fails the run.
    expect(model(GITHUB_COPILOT_PROVIDER_ID)).toBe("claude-sonnet-5.5");
  });

  test("a task-board run stays on Opus whatever a chat would pick", () => {
    expect(
      claudeCodeEnvFromCredential(
        { providerId: "anthropic", apiKey: "sk-a" },
        "default",
        "claude-sonnet-5",
      ).CLAUDE_CODE_MODEL,
    ).toBe("claude-opus-5-5");
  });

  test("reviewer and conflict runs keep their class model whatever was chosen", () => {
    for (const [modelClass, expectedModel] of [
      ["reviewer", "claude-sonnet-5-5"],
      ["conflict", "claude-sonnet-5-5"],
    ] as const) {
      expect(
        claudeCodeEnvFromCredential(
          { providerId: "anthropic", apiKey: "sk-a" },
          modelClass,
          "claude-opus-5-5",
        ).CLAUDE_CODE_MODEL,
      ).toBe(expectedModel);
    }
  });

  test("omitting the class keeps the model every run had before", () => {
    expect(
      claudeCodeEnvFromCredential({ providerId: "openrouter", apiKey: "or-1" })
        .CLAUDE_CODE_MODEL,
    ).toBe("anthropic/claude-opus-5.5");
  });

  test("modelClassFromMetadata only trusts the exact class values", () => {
    expect(modelClassFromMetadata("reviewer")).toBe("reviewer");
    expect(modelClassFromMetadata("conflict")).toBe("conflict");
    for (const value of [
      undefined,
      "",
      "default",
      "Reviewer",
      "Conflict",
      "qa",
      "cheap",
    ]) {
      expect(modelClassFromMetadata(value)).toBe("default");
    }
  });

  test("a conflict re-run runs on the cheap tier, capped like a reviewer", () => {
    const env = claudeCodeEnvFromCredential(
      { providerId: "anthropic", apiKey: "sk-a" },
      "conflict",
    );
    expect(env.CLAUDE_CODE_MODEL).toBe("claude-sonnet-5-5");
    expect(env.CLAUDE_CODE_MAX_TURNS).toBe("60");
    expect(
      claudeCodeEnvFromCredential(
        { providerId: "openrouter", apiKey: "sk-o" },
        "conflict",
      ).CLAUDE_CODE_MODEL,
    ).toBe("anthropic/claude-sonnet-5.5");
    expect(
      claudeCodeEnvFromCredential(
        { providerId: GITHUB_COPILOT_PROVIDER_ID, apiKey: "copilot-token" },
        "conflict",
      ).CLAUDE_CODE_MODEL,
    ).toBe("claude-sonnet-5.5");
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

describe("one Claude lineup", () => {
  const catalog = (providerId: "anthropic" | "openrouter" | "deco") =>
    [
      ...(SMART_MODEL_PREFERENCES[providerId] ?? []),
      ...(THINKING_MODEL_PREFERENCES[providerId] ?? []),
    ].map(
      (modelId): AiProviderModel => ({
        providerId,
        modelId,
        title: modelId,
        description: null,
        logo: null,
        capabilities: ["text"],
        limits: null,
        costs: null,
      }),
    );
  const tierDefaults = (providerId: "anthropic" | "openrouter" | "deco") => {
    const key: AiProviderKey = {
      id: "key-1",
      providerId,
      label: providerId,
      presetId: null,
      createdBy: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    return pickSimpleModeDefaults([key], { [key.id]: catalog(providerId) })
      .chat;
  };
  const harnessModel = (
    providerId: string,
    modelClass: "default" | "chat" | "reviewer" | "conflict",
  ) =>
    claudeCodeEnvFromCredential({ providerId, apiKey: "k" }, modelClass)
      .CLAUDE_CODE_MODEL ?? null;

  test.each([["anthropic"], ["openrouter"], ["deco"]] as const)(
    "on %s the default chat tier's model is the one a chat and a builder run",
    (providerId) => {
      const picked = tierDefaults(providerId)[DEFAULT_CHAT_TIER]?.modelId;
      expect(picked).toContain("claude-opus-");
      expect(harnessModel(providerId, "chat")).toBe(picked ?? null);
      expect(harnessModel(providerId, "default")).toBe(picked ?? null);
    },
  );

  test.each([["anthropic"], ["openrouter"], ["deco"]] as const)(
    "on %s the Smart tier default is the model the cheap classes run",
    (providerId) => {
      const smart = tierDefaults(providerId).smart?.modelId;
      expect(smart).toContain("claude-sonnet-");
      expect(harnessModel(providerId, "reviewer")).toBe(smart ?? null);
      expect(harnessModel(providerId, "conflict")).toBe(smart ?? null);
    },
  );

  test("Copilot's ids are the same versions in Copilot's form", () => {
    const copilotClass = (modelClass: "reviewer" | "conflict") =>
      claudeCodeEnvFromCredential(
        { providerId: GITHUB_COPILOT_PROVIDER_ID, apiKey: "t" },
        modelClass,
      ).CLAUDE_CODE_MODEL;
    for (const modelClass of ["reviewer", "conflict"] as const) {
      for (const providerId of ["anthropic", "openrouter"]) {
        const own = claudeCodeEnvFromCredential(
          { providerId, apiKey: "k" },
          modelClass,
        ).CLAUDE_CODE_MODEL;
        expect(copilotModelId(own ?? "")).toBe(
          copilotClass(modelClass) ?? null,
        );
      }
    }
  });
});

describe("tool search", () => {
  // The regression: an OpenRouter run loads every mounted MCP schema into the
  // turn-1 prompt unless this is set, and one org's 22 connections came to
  // ~1.5MB — every run failed on `Prompt is too long` before its first tool
  // call. Every provider shape carries it; a first-party credential already
  // defers by default, so it is a no-op there rather than a second code path.
  test.each([
    ["anthropic"],
    ["openrouter"],
    ["deco"],
    [CLAUDE_SUBSCRIPTION_PROVIDER_ID],
    [GITHUB_COPILOT_PROVIDER_ID],
  ])("%s runs get ENABLE_TOOL_SEARCH", (providerId) => {
    expect(
      claudeCodeEnvFromCredential({ providerId, apiKey: "k" })
        .ENABLE_TOOL_SEARCH,
    ).toBe("1");
  });

  test("it is never deleted, so a pod cannot inherit it unset", () => {
    for (const providerId of ["anthropic", "openrouter", "deco"]) {
      for (const modelClass of ["default", "reviewer", "conflict"] as const) {
        expect(
          claudeCodeEnvFromCredential({ providerId, apiKey: "k" }, modelClass)
            .ENABLE_TOOL_SEARCH,
        ).not.toBeNull();
      }
    }
  });
});

describe("claudeSubscriptionChatModel", () => {
  test("runs the Claude model the user picked", () => {
    expect(
      claudeSubscriptionChatModel(
        CLAUDE_SUBSCRIPTION_PROVIDER_ID,
        "claude-opus-5-5",
      ).thinking,
    ).toEqual({
      id: "claude-opus-5-5",
      title: "claude-opus-5-5",
      provider: "anthropic",
    });
  });

  test("falls back to the harness default without a Claude pick", () => {
    const fallback = claudeSubscriptionChatModel().thinking.id;
    for (const picked of [
      undefined,
      "",
      "gpt-5",
      "anthropic/claude-opus-5-5",
    ]) {
      expect(
        claudeSubscriptionChatModel(CLAUDE_SUBSCRIPTION_PROVIDER_ID, picked)
          .thinking.id,
      ).toBe(fallback);
    }
  });
});
