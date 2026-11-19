import { describe, expect, it } from "bun:test";
import type { AiProviderKey, AiProviderModel } from "../types/ai-providers";
import {
  getFastModel,
  isChatModel,
  pickSimpleModeDefaults,
  selectDefaultModel,
} from "./default-model";

const key: AiProviderKey = {
  id: "anthropic-key",
  providerId: "anthropic",
  label: "Anthropic",
  presetId: null,
  createdBy: "user-1",
  createdAt: "2026-07-13T00:00:00.000Z",
};

function model(modelId: string, title: string): AiProviderModel {
  return {
    providerId: "anthropic",
    modelId,
    title,
    description: null,
    logo: null,
    capabilities: ["text", "reasoning"],
    limits: null,
    costs: null,
  };
}

describe("default model preferences", () => {
  const models = [
    model("claude-opus-4-8", "Claude Opus 4.8"),
    model("claude-sonnet-5", "Claude Sonnet 5"),
    model("claude-haiku-4-5", "Claude Haiku 4.5"),
  ];

  it("selects the provider's preferred default model", () => {
    expect(selectDefaultModel(models, "anthropic", key.id)).toMatchObject({
      keyId: "anthropic-key",
      modelId: "claude-sonnet-5",
      title: "Claude Sonnet 5",
    });
  });

  it("returns the provider's preferred fast model", () => {
    expect(getFastModel("anthropic")).toBe("claude-haiku-4-5");
  });

  it("still fills the tiers from a catalog without the current lineup", () => {
    const defaults = pickSimpleModeDefaults([key], {
      [key.id]: models,
    });

    expect(defaults.chat.fast).toEqual({
      keyId: key.id,
      modelId: "claude-haiku-4-5",
      title: "Claude Haiku 4.5",
    });
    expect(defaults.chat.smart).toEqual({
      keyId: key.id,
      modelId: "claude-sonnet-5",
      title: "Claude Sonnet 5",
    });
    expect(defaults.chat.thinking).toEqual({
      keyId: key.id,
      modelId: "claude-opus-4-8",
      title: "Claude Opus 4.8",
    });
  });
});

describe("current Claude lineup in the chat tiers", () => {
  function keyFor(providerId: AiProviderKey["providerId"]): AiProviderKey {
    return { ...key, id: `${providerId}-key`, providerId };
  }
  function tiers(
    providerId: AiProviderKey["providerId"],
    modelIds: string[],
  ): { smart?: string; thinking?: string } {
    const providerKey = keyFor(providerId);
    const { chat } = pickSimpleModeDefaults([providerKey], {
      [providerKey.id]: modelIds.map((id) => model(id, id)),
    });
    return { smart: chat.smart?.modelId, thinking: chat.thinking?.modelId };
  }

  it("puts Sonnet 5.5 on Smart and Opus 5.5 on Thinking", () => {
    expect(
      tiers("anthropic", [
        "claude-sonnet-5",
        "claude-opus-4-8",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
      ]),
    ).toEqual({ smart: "claude-sonnet-5-5", thinking: "claude-opus-5-5" });

    for (const providerId of ["openrouter", "deco"] as const) {
      expect(
        tiers(providerId, [
          "anthropic/claude-sonnet-5",
          "anthropic/claude-opus-4.8",
          "anthropic/claude-opus-5.5",
          "anthropic/claude-sonnet-5.5",
        ]),
      ).toEqual({
        smart: "anthropic/claude-sonnet-5.5",
        thinking: "anthropic/claude-opus-5.5",
      });
    }
  });

  it("keeps Smart off Opus when the catalog has no Sonnet 5.5", () => {
    expect(
      tiers("anthropic", [
        "claude-sonnet-5",
        "claude-opus-4-8",
        "claude-opus-5-5",
      ]),
    ).toEqual({ smart: "claude-sonnet-5", thinking: "claude-opus-5-5" });
  });

  it("matches dated ids of the current lineup", () => {
    expect(
      tiers("anthropic", [
        "claude-sonnet-4-6",
        "claude-sonnet-5-5-20261001",
        "claude-opus-5-5-20261001",
      ]),
    ).toEqual({
      smart: "claude-sonnet-5-5-20261001",
      thinking: "claude-opus-5-5-20261001",
    });
  });
});

describe("image slot", () => {
  const decoKey: AiProviderKey = {
    id: "deco-key",
    providerId: "deco",
    label: "Deco",
    presetId: null,
    createdBy: "user-1",
    createdAt: "2026-09-10T00:00:00.000Z",
  };

  function orModel(
    modelId: string,
    capabilities: AiProviderModel["capabilities"],
  ): AiProviderModel {
    return {
      providerId: "openrouter",
      modelId,
      title: modelId,
      description: null,
      logo: null,
      capabilities,
      limits: null,
      costs: null,
    };
  }

  // The bug: the auto-router advertises image output, so a bare capability scan
  // picked it, and it resolved image calls to an arbitrary text model.
  it("never picks the auto-router, even when it is the only image match", () => {
    const defaults = pickSimpleModeDefaults([decoKey], {
      [decoKey.id]: [
        orModel("openrouter/auto-beta", ["text", "vision", "image"]),
        orModel("z-ai/glm-5.2", ["text"]),
      ],
    });

    expect(defaults.image).toBeNull();
  });

  it("prefers a real image model over the auto-router", () => {
    const defaults = pickSimpleModeDefaults([decoKey], {
      [decoKey.id]: [
        orModel("openrouter/auto-beta", ["text", "vision", "image"]),
        orModel("google/gemini-3-pro-image", ["text", "image"]),
      ],
    });

    expect(defaults.image?.modelId).toBe("google/gemini-3-pro-image");
  });
});

describe("decision models", () => {
  const decision = {
    ...model("claude-sonnet-decisions", "Decisions"),
    capabilities: ["text", "decisions"] as const,
  };
  const decisionModel: AiProviderModel = {
    ...decision,
    capabilities: [...decision.capabilities],
  };
  it("cannot become the chat fallback even when they accept text", () => {
    expect(isChatModel(decisionModel)).toBe(false);
    expect(selectDefaultModel([decisionModel], "anthropic")).toBeNull();
    const chat = model("another-chat", "Chat");
    expect(
      selectDefaultModel([decisionModel, chat], "anthropic")?.modelId,
    ).toBe("another-chat");
  });
  it("does not fill chat tiers by a matching model name", () => {
    expect(
      pickSimpleModeDefaults([key], { [key.id]: [decisionModel] }).chat,
    ).toEqual({ fast: null, smart: null, thinking: null });
  });
});
