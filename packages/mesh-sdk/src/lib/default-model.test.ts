import { describe, expect, it } from "bun:test";
import type { AiProviderKey, AiProviderModel } from "../types/ai-providers";
import {
  getFastModel,
  pickSimpleModeDefaults,
  selectDefaultModel,
} from "./default-model";

const key: AiProviderKey = {
  id: "codex-key",
  providerId: "codex",
  label: "Codex",
  presetId: null,
  createdBy: "user-1",
  createdAt: "2026-07-13T00:00:00.000Z",
};

function model(modelId: string, title: string): AiProviderModel {
  return {
    providerId: "codex",
    modelId,
    title,
    description: null,
    logo: null,
    capabilities: ["text", "reasoning"],
    limits: null,
    costs: null,
  };
}

describe("Codex default model preferences", () => {
  const models = [
    model("codex:gpt-5.6-sol", "GPT-5.6 Sol"),
    model("codex:gpt-5.6-terra", "GPT-5.6 Terra"),
    model("codex:gpt-5.6-luna", "GPT-5.6 Luna"),
  ];

  it("uses GPT-5.6 Terra as the default Codex model", () => {
    expect(selectDefaultModel(models, "codex", key.id)).toMatchObject({
      keyId: "codex-key",
      modelId: "codex:gpt-5.6-terra",
      title: "GPT-5.6 Terra",
    });
  });

  it("uses GPT-5.6 Luna as the fast Codex model", () => {
    expect(getFastModel("codex")).toBe("codex:gpt-5.6-luna");
  });

  it("maps simple-mode Codex tiers to Luna, Terra, and Sol", () => {
    const defaults = pickSimpleModeDefaults([key], {
      [key.id]: models,
    });

    expect(defaults.chat.fast).toEqual({
      keyId: key.id,
      modelId: "codex:gpt-5.6-luna",
      title: "GPT-5.6 Luna",
    });
    expect(defaults.chat.smart).toEqual({
      keyId: key.id,
      modelId: "codex:gpt-5.6-terra",
      title: "GPT-5.6 Terra",
    });
    expect(defaults.chat.thinking).toEqual({
      keyId: key.id,
      modelId: "codex:gpt-5.6-sol",
      title: "GPT-5.6 Sol",
    });
  });
});
