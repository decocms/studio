import { describe, expect, it } from "bun:test";
import { selectDefaultModel } from "./default-model";
import type { AiProviderModel } from "../types/ai-providers";

function model(modelId: string): AiProviderModel {
  return {
    providerId: "anthropic",
    modelId,
    title: modelId,
    description: null,
    logo: null,
    capabilities: [],
    limits: null,
    costs: null,
  };
}

describe("selectDefaultModel", () => {
  it("returns null for an empty model list", () => {
    expect(selectDefaultModel([], "anthropic")).toBeNull();
  });

  it("prefers an exact match over a later, higher-priority substring match", () => {
    const models = [model("claude-sonnet-legacy"), model("claude-sonnet-5")];
    const result = selectDefaultModel(models, "anthropic");
    expect(result?.modelId).toBe("claude-sonnet-5");
  });

  it("falls back to a substring match when no candidate matches exactly", () => {
    const models = [model("some-claude-sonnet-variant")];
    const result = selectDefaultModel(models, "anthropic");
    expect(result?.modelId).toBe("some-claude-sonnet-variant");
  });

  it("falls back to the first model when no preference matches at all", () => {
    const models = [model("gpt-5"), model("gemini-3")];
    const result = selectDefaultModel(models, "anthropic");
    expect(result?.modelId).toBe("gpt-5");
  });

  it("returns the first model as-is for a provider with no configured preferences", () => {
    const models = [model("openai-compatible-model")];
    const result = selectDefaultModel(models, "openai-compatible");
    expect(result?.modelId).toBe("openai-compatible-model");
  });

  it("attaches keyId to the selected model when provided", () => {
    const models = [model("claude-sonnet-5")];
    const result = selectDefaultModel(models, "anthropic", "key-123");
    expect(result?.keyId).toBe("key-123");
  });

  it("omits keyId when not provided", () => {
    const models = [model("claude-sonnet-5")];
    const result = selectDefaultModel(models, "anthropic");
    expect(result?.keyId).toBeUndefined();
  });
});
