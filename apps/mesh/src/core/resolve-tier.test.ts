import { describe, expect, it, mock } from "bun:test";
import type { MeshContext } from "@/core/mesh-context";
import { resolveTier, TierUnavailableError } from "./resolve-tier";

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
  providerKeys?: ProviderKeyFixture[];
  models?: Record<string, ModelFixture[]>;
  listModelsThrows?: boolean;
}): MeshContext {
  return {
    organization: { id: "org_1" },
    storage: {
      organizationSettings: {
        get: mock(() =>
          Promise.resolve(
            opts.tiers ? { simple_mode: { tiers: opts.tiers } } : null,
          ),
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
  } as unknown as MeshContext;
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
      listModelsThrows: true,
    });
    const result = await resolveTier(ctx, "smart");
    expect(result.credentialId).toBe("k1");
    expect(result.modelId).toBe("gpt-5");
    expect(result.modelMeta.title).toBe("gpt-5");
  });
});
