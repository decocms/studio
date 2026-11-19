import { describe, expect, it, mock } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { DEFAULT_CHAT_TIER } from "@decocms/shared/organization/schema";
import {
  resolveDefaultChatTier,
  resolveTier,
  TierUnavailableError,
} from "./resolve-tier";

interface ProviderKeyFixture {
  id: string;
  providerId: string;
  createdAt: string;
  label?: string;
  presetId?: string | null;
  createdBy?: string;
}

interface ModelFixture {
  modelId: string;
  title: string;
  providerId?: string;
  capabilities?: string[];
  limits?: {
    contextWindow: number;
    maxOutputTokens: number | null;
  } | null;
}

function makeCtx(opts: {
  tiers?: Record<string, { keyId: string; modelId: string } | null>;
  userTiers?: Record<string, { keyId: string; modelId: string } | null>;
  userId?: string;
  providerKeys?: ProviderKeyFixture[];
  models?: Record<string, ModelFixture[]>;
  listModelsThrows?: boolean;
}): StudioContext {
  return {
    organization: { id: "org_1" },
    auth: { user: { id: opts.userId ?? "user_1" } },
    storage: {
      organizationSettings: {
        get: mock(() =>
          Promise.resolve(
            opts.tiers ? { simple_mode: { tiers: opts.tiers } } : null,
          ),
        ),
      },
      userModelPreferences: {
        get: mock(() =>
          Promise.resolve(opts.userTiers ? { tiers: opts.userTiers } : null),
        ),
      },
      aiProviderKeys: {
        list: mock(() =>
          Promise.resolve(
            (opts.providerKeys ?? []).map((k) => ({
              id: k.id,
              providerId: k.providerId,
              label: k.label ?? "",
              presetId: k.presetId ?? null,
              createdBy: k.createdBy ?? "u",
              createdAt: k.createdAt,
            })),
          ),
        ),
      },
    },
    aiProviders: {
      listModels: mock((keyId: string) => {
        if (opts.listModelsThrows) return Promise.reject(new Error("boom"));
        return Promise.resolve(opts.models?.[keyId] ?? []);
      }),
    },
  } as unknown as StudioContext;
}

describe("resolveTier", () => {
  it("returns the configured slot when set", async () => {
    const ctx = makeCtx({
      tiers: {
        smart: { keyId: "k1", modelId: "claude-sonnet-4-6" },
        fast: null,
        thinking: null,
        image: null,
        web_research: null,
      },
      providerKeys: [
        { id: "k1", providerId: "anthropic", createdAt: "2026-01-01" },
      ],
      models: {
        k1: [{ modelId: "claude-sonnet-4-6", title: "Claude Sonnet 4.6" }],
      },
    });
    const result = await resolveTier(ctx, "smart");
    expect(result.credentialId).toBe("k1");
    expect(result.modelId).toBe("claude-sonnet-4-6");
    expect(result.modelMeta.title).toBe("Claude Sonnet 4.6");
  });

  it("falls back to SDK defaults when slot is unset (anthropic → smart)", async () => {
    const ctx = makeCtx({
      tiers: {
        smart: null,
        fast: null,
        thinking: null,
        image: null,
        web_research: null,
      },
      providerKeys: [
        { id: "ka", providerId: "anthropic", createdAt: "2026-01-01" },
      ],
      models: {
        ka: [{ modelId: "claude-sonnet-4-6", title: "Claude Sonnet 4.6" }],
      },
    });
    const result = await resolveTier(ctx, "smart");
    expect(result.credentialId).toBe("ka");
    expect(result.modelId).toBe("claude-sonnet-4-6");
  });

  it("falls back to SDK defaults for openrouter (covers the bug case)", async () => {
    const ctx = makeCtx({
      tiers: undefined,
      providerKeys: [
        { id: "kor", providerId: "openrouter", createdAt: "2026-01-01" },
      ],
      models: {
        kor: [
          {
            modelId: "anthropic/claude-sonnet-4.6",
            title: "Claude Sonnet 4.6",
          },
        ],
      },
    });
    const result = await resolveTier(ctx, "smart");
    expect(result.credentialId).toBe("kor");
    expect(result.modelId).toBe("anthropic/claude-sonnet-4.6");
  });

  it("throws TierUnavailableError when no providers connected", async () => {
    const ctx = makeCtx({
      tiers: undefined,
      providerKeys: [],
    });
    await expect(resolveTier(ctx, "smart")).rejects.toBeInstanceOf(
      TierUnavailableError,
    );
  });

  it("tolerates listModels failure on a configured slot", async () => {
    const ctx = makeCtx({
      tiers: {
        smart: { keyId: "k1", modelId: "gpt-5" },
        fast: null,
        thinking: null,
        image: null,
        web_research: null,
      },
      providerKeys: [
        {
          id: "k1",
          providerId: "openai-compatible",
          createdAt: "2026-01-01",
        },
      ],
      listModelsThrows: true,
    });
    const result = await resolveTier(ctx, "smart");
    expect(result.credentialId).toBe("k1");
    expect(result.modelId).toBe("gpt-5");
    expect(result.modelMeta.title).toBe("gpt-5");
  });

  it("prefers a user override over the org slot", async () => {
    const ctx = makeCtx({
      tiers: {
        smart: { keyId: "k1", modelId: "org-model" },
        fast: null,
        thinking: null,
        image: null,
        web_research: null,
      },
      userTiers: { smart: { keyId: "k1", modelId: "user-model" } },
      providerKeys: [
        { id: "k1", providerId: "anthropic", createdAt: "2026-01-01" },
      ],
      models: {
        k1: [
          { modelId: "org-model", title: "Org Model" },
          { modelId: "user-model", title: "User Model" },
        ],
      },
    });
    const result = await resolveTier(ctx, "smart", { applyUserPrefs: true });
    expect(result.modelId).toBe("user-model");
    expect(result.modelMeta.title).toBe("User Model");
  });

  it("ignores the user override unless the caller opts in", async () => {
    // Automations, the task-board super agent, background tools, the
    // commit-message suggester and the review judge all resolve tiers without
    // `applyUserPrefs` — none of them may follow a personal chat preference.
    const ctx = makeCtx({
      tiers: { smart: { keyId: "k1", modelId: "org-model" } },
      userTiers: { smart: { keyId: "k1", modelId: "user-model" } },
      providerKeys: [
        { id: "k1", providerId: "anthropic", createdAt: "2026-01-01" },
      ],
      models: {
        k1: [
          { modelId: "org-model", title: "Org Model" },
          { modelId: "user-model", title: "User Model" },
        ],
      },
    });
    const result = await resolveTier(ctx, "smart");
    expect(result.modelId).toBe("org-model");
    // The preferences row must not even be read on the default path.
    expect(ctx.storage.userModelPreferences.get).not.toHaveBeenCalled();
  });

  it("falls back to the org slot when the user override key is stale", async () => {
    const ctx = makeCtx({
      tiers: { smart: { keyId: "k_live", modelId: "org-model" } },
      userTiers: { smart: { keyId: "k_deleted", modelId: "stale-user-model" } },
      providerKeys: [
        { id: "k_live", providerId: "anthropic", createdAt: "2026-01-01" },
      ],
      models: {
        k_live: [{ modelId: "org-model", title: "Org Model" }],
      },
    });
    const result = await resolveTier(ctx, "smart", { applyUserPrefs: true });
    expect(result.credentialId).toBe("k_live");
    expect(result.modelId).toBe("org-model");
  });

  it("ignores user overrides for non-chat tiers (image)", async () => {
    const ctx = makeCtx({
      tiers: {
        image: { keyId: "k1", modelId: "org-image-model" },
      },
      // A malformed/legacy override for a non-chat tier must not win.
      userTiers: { image: { keyId: "k1", modelId: "user-image-model" } },
      providerKeys: [
        {
          id: "k1",
          providerId: "openai-compatible",
          createdAt: "2026-01-01",
        },
      ],
      models: {
        k1: [
          { modelId: "org-image-model", title: "Org Image" },
          { modelId: "user-image-model", title: "User Image" },
        ],
      },
    });
    const result = await resolveTier(ctx, "image", { applyUserPrefs: true });
    expect(result.modelId).toBe("org-image-model");
  });

  it("falls through to default-pick when slot references a deleted key", async () => {
    const ctx = makeCtx({
      tiers: {
        smart: { keyId: "k_deleted", modelId: "stale-model" },
        fast: null,
        thinking: null,
        image: null,
        web_research: null,
      },
      providerKeys: [
        { id: "k_live", providerId: "anthropic", createdAt: "2026-01-01" },
      ],
      models: {
        k_live: [{ modelId: "claude-sonnet-4-6", title: "Claude Sonnet 4.6" }],
      },
    });
    const result = await resolveTier(ctx, "smart");
    expect(result.credentialId).toBe("k_live");
    expect(result.modelId).toBe("claude-sonnet-4-6");
  });
});

describe("resolveDefaultChatTier", () => {
  const anthropicKey = {
    id: "k1",
    providerId: "anthropic",
    createdAt: "2026-01-01",
  };
  const noTiers = {
    fast: null,
    smart: null,
    thinking: null,
    image: null,
    web_research: null,
  };

  it("the default chat tier is Thinking", () => {
    expect(DEFAULT_CHAT_TIER).toBe("thinking");
  });

  it("runs the org's Thinking slot, not its Smart slot", async () => {
    const ctx = makeCtx({
      tiers: {
        ...noTiers,
        smart: { keyId: "k1", modelId: "org-smart" },
        thinking: { keyId: "k1", modelId: "org-thinking" },
      },
      providerKeys: [anthropicKey],
    });
    expect((await resolveDefaultChatTier(ctx)).modelId).toBe("org-thinking");
  });

  it("default-picks the current Opus when no slot is saved", async () => {
    const ctx = makeCtx({
      providerKeys: [anthropicKey],
      models: {
        k1: [
          { modelId: "claude-sonnet-5-5", title: "Claude Sonnet 5.5" },
          { modelId: "claude-opus-5-5", title: "Claude Opus 5.5" },
        ],
      },
    });
    expect((await resolveDefaultChatTier(ctx)).modelId).toBe("claude-opus-5-5");
    expect((await resolveTier(ctx, "smart")).modelId).toBe("claude-sonnet-5-5");
  });

  it("falls back to Smart for an org with no Thinking model", async () => {
    const ctx = makeCtx({
      tiers: { ...noTiers, smart: { keyId: "k1", modelId: "local-model" } },
      providerKeys: [
        { id: "k1", providerId: "openai-compatible", createdAt: "2026-01-01" },
      ],
      models: { k1: [{ modelId: "local-model", title: "Local" }] },
    });
    expect((await resolveDefaultChatTier(ctx)).modelId).toBe("local-model");
    await expect(resolveTier(ctx, "thinking")).rejects.toBeInstanceOf(
      TierUnavailableError,
    );
  });

  it("follows the user's Thinking override when the chat opts in", async () => {
    const ctx = makeCtx({
      tiers: { ...noTiers, thinking: { keyId: "k1", modelId: "org-thinking" } },
      userTiers: { thinking: { keyId: "k1", modelId: "user-thinking" } },
      providerKeys: [anthropicKey],
    });
    expect(
      (await resolveDefaultChatTier(ctx, { applyUserPrefs: true })).modelId,
    ).toBe("user-thinking");
  });

  it("still fails when the org has no model for either tier", async () => {
    const ctx = makeCtx({ providerKeys: [] });
    await expect(resolveDefaultChatTier(ctx)).rejects.toBeInstanceOf(
      TierUnavailableError,
    );
  });
});
