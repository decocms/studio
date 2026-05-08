import { describe, expect, it, mock } from "bun:test";
import type { MeshContext } from "@/core/mesh-context";
import { resolveTierOverride } from "./resolve-tier-override";

type SettingsValue = {
  simple_mode: {
    enabled: boolean;
    chat: Record<
      "fast" | "smart" | "thinking",
      { keyId: string; modelId: string; title?: string } | null
    >;
  } | null;
} | null;

function makeCtx(opts: {
  settings: SettingsValue;
  models?: Array<{
    modelId: string;
    title: string;
    providerId: string;
    capabilities: Array<
      "text" | "image" | "vision" | "audio" | "video" | "file" | "reasoning"
    >;
    limits: { contextWindow: number; maxOutputTokens: number | null } | null;
  }>;
  listModelsThrows?: boolean;
}): MeshContext {
  return {
    storage: {
      organizationSettings: {
        get: mock(() => Promise.resolve(opts.settings)),
      },
    },
    aiProviders: {
      listModels: mock(() => {
        if (opts.listModelsThrows) {
          return Promise.reject(new Error("provider unavailable"));
        }
        return Promise.resolve(opts.models ?? []);
      }),
    },
  } as unknown as MeshContext;
}

describe("resolveTierOverride", () => {
  it("returns null when models has no tier", async () => {
    const ctx = makeCtx({ settings: null });
    const result = await resolveTierOverride(ctx, {
      models: JSON.stringify({ credentialId: "c", thinking: { id: "m" } }),
      organization_id: "org_1",
    });
    expect(result).toBeNull();
  });

  it("returns null when simple mode is disabled", async () => {
    const ctx = makeCtx({
      settings: {
        simple_mode: {
          enabled: false,
          chat: {
            fast: null,
            smart: { keyId: "k", modelId: "m" },
            thinking: null,
          },
        },
      },
    });
    const result = await resolveTierOverride(ctx, {
      models: JSON.stringify({ tier: "smart" }),
      organization_id: "org_1",
    });
    expect(result).toBeNull();
  });

  it("returns null when the configured tier slot is unset", async () => {
    const ctx = makeCtx({
      settings: {
        simple_mode: {
          enabled: true,
          chat: { fast: null, smart: null, thinking: null },
        },
      },
    });
    const result = await resolveTierOverride(ctx, {
      models: JSON.stringify({ tier: "smart" }),
      organization_id: "org_1",
    });
    expect(result).toBeNull();
  });

  it("translates ModelInfo into the thinking shape with capability flags", async () => {
    const ctx = makeCtx({
      settings: {
        simple_mode: {
          enabled: true,
          chat: {
            fast: null,
            smart: { keyId: "k_smart", modelId: "claude-3-5-sonnet" },
            thinking: null,
          },
        },
      },
      models: [
        {
          modelId: "claude-3-5-sonnet",
          title: "Claude 3.5 Sonnet",
          providerId: "anthropic",
          capabilities: ["text", "vision", "file", "reasoning"],
          limits: { contextWindow: 200_000, maxOutputTokens: 8192 },
        },
      ],
    });
    const result = await resolveTierOverride(ctx, {
      models: JSON.stringify({ tier: "smart" }),
      organization_id: "org_1",
    });
    expect(result).toEqual({
      credentialId: "k_smart",
      thinking: {
        id: "claude-3-5-sonnet",
        title: "Claude 3.5 Sonnet",
        provider: "anthropic",
        capabilities: {
          vision: true,
          text: true,
          reasoning: true,
          file: true,
        },
        limits: { contextWindow: 200_000, maxOutputTokens: 8192 },
      },
    });
  });

  it("falls back to slot-only override when listModels throws", async () => {
    const ctx = makeCtx({
      settings: {
        simple_mode: {
          enabled: true,
          chat: {
            fast: null,
            smart: { keyId: "k", modelId: "m", title: "Stored Title" },
            thinking: null,
          },
        },
      },
      listModelsThrows: true,
    });
    const result = await resolveTierOverride(ctx, {
      models: JSON.stringify({ tier: "smart" }),
      organization_id: "org_1",
    });
    expect(result).toEqual({
      credentialId: "k",
      thinking: { id: "m", title: "Stored Title" },
    });
  });

  it("returns null on malformed models JSON", async () => {
    const ctx = makeCtx({ settings: null });
    const result = await resolveTierOverride(ctx, {
      models: "{not json",
      organization_id: "org_1",
    });
    expect(result).toBeNull();
  });
});
