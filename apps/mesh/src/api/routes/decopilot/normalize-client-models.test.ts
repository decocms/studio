/**
 * Pure unit tests for the client→v2 models normalization (no mocks, no IO).
 */
import { describe, expect, it } from "bun:test";
import {
  normalizeClientModels,
  type ClientModelsInput,
} from "./normalize-client-models";

const ROOT_CREDENTIAL = "aik_root";

function baseInput(
  overrides: Partial<ClientModelsInput> = {},
): ClientModelsInput {
  return {
    credentialId: ROOT_CREDENTIAL,
    thinking: { id: "claude-opus-4-5", title: "Opus" },
    ...overrides,
  };
}

describe("normalizeClientModels", () => {
  it("gives thinking/fast/smart the root client credential", () => {
    const result = normalizeClientModels(
      baseInput({
        fast: { id: "claude-haiku-4-5", title: "Haiku" },
        smart: { id: "claude-sonnet-4-6", title: "Sonnet" },
      }),
    );

    expect(result.thinking.credentialId).toBe(ROOT_CREDENTIAL);
    expect(result.fast?.credentialId).toBe(ROOT_CREDENTIAL);
    expect(result.smart?.credentialId).toBe(ROOT_CREDENTIAL);
  });

  it("keeps image/deepResearch own credential when pinned", () => {
    const result = normalizeClientModels(
      baseInput({
        image: { id: "gpt-image-1", credentialId: "aik_image" },
        deepResearch: { id: "o3-deep-research", credentialId: "aik_research" },
      }),
    );

    expect(result.image?.credentialId).toBe("aik_image");
    expect(result.deepResearch?.credentialId).toBe("aik_research");
  });

  it("defaults image/deepResearch to the root credential when not pinned", () => {
    const result = normalizeClientModels(
      baseInput({
        image: { id: "gpt-image-1" },
        deepResearch: { id: "o3-deep-research" },
      }),
    );

    expect(result.image?.credentialId).toBe(ROOT_CREDENTIAL);
    expect(result.deepResearch?.credentialId).toBe(ROOT_CREDENTIAL);
  });

  it("omits optional slots the client did not send", () => {
    const result = normalizeClientModels(baseInput());

    expect(result).not.toHaveProperty("fast");
    expect(result).not.toHaveProperty("smart");
    expect(result).not.toHaveProperty("image");
    expect(result).not.toHaveProperty("deepResearch");
  });

  it("drops the removed coding slot (D11)", () => {
    const result = normalizeClientModels(
      baseInput({ coding: { id: "claude-sonnet-4-6" } }),
    );

    expect(result).not.toHaveProperty("coding");
  });

  it("passes wire-allowed capabilities through per slot", () => {
    const result = normalizeClientModels(
      baseInput({
        thinking: {
          id: "claude-opus-4-5",
          title: "Opus",
          capabilities: { reasoning: true, vision: true },
        },
        fast: {
          id: "claude-haiku-4-5",
          capabilities: { reasoning: false },
        },
      }),
    );

    expect(result.thinking.capabilities).toEqual({
      reasoning: true,
      vision: true,
    });
    expect(result.fast?.capabilities).toEqual({ reasoning: false });
  });

  it("drops non-wire capability keys (tools/file) on passthrough", () => {
    const result = normalizeClientModels(
      baseInput({
        thinking: {
          id: "claude-opus-4-5",
          title: "Opus",
          capabilities: { reasoning: true, tools: true, file: true },
        },
      }),
    );

    expect(result.thinking.capabilities).toEqual({ reasoning: true });
  });

  it("omits capabilities entirely when only non-wire keys are present", () => {
    const result = normalizeClientModels(
      baseInput({
        thinking: {
          id: "claude-opus-4-5",
          title: "Opus",
          capabilities: { tools: true, file: true },
        },
      }),
    );

    expect("capabilities" in result.thinking).toBe(false);
  });

  it("falls back thinking.title to the model id (wire requires it)", () => {
    const result = normalizeClientModels(
      baseInput({ thinking: { id: "claude-opus-4-5" } }),
    );

    expect(result.thinking.title).toBe("claude-opus-4-5");
  });

  it("preserves title/provider/limits per slot", () => {
    const result = normalizeClientModels(
      baseInput({
        thinking: {
          id: "claude-opus-4-5",
          title: "Opus",
          provider: "anthropic",
          limits: { contextWindow: 200_000, maxOutputTokens: 64_000 },
        },
        fast: { id: "claude-haiku-4-5", provider: null },
      }),
    );

    expect(result.thinking).toEqual({
      id: "claude-opus-4-5",
      title: "Opus",
      provider: "anthropic",
      credentialId: ROOT_CREDENTIAL,
      limits: { contextWindow: 200_000, maxOutputTokens: 64_000 },
    });
    expect(result.fast).toEqual({
      id: "claude-haiku-4-5",
      provider: null,
      credentialId: ROOT_CREDENTIAL,
    });
  });
});
