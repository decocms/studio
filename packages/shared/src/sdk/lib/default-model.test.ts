import { describe, expect, it } from "bun:test";
import type { AiProviderKey, AiProviderModel } from "../types/ai-providers";
import {
  getFastModel,
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

  it("maps simple-mode tiers to the provider's preferred models", () => {
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
        orModel("z-ai/glm-5.2", ["text", "tools"]),
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
