/**
 * Tests for Model Permissions
 *
 * Tests the pure utility functions for checking and parsing model permissions.
 * The permission format uses composite "connectionId:modelId" strings under a "models" key.
 */

import { describe, expect, it } from "bun:test";
import {
  checkModelPermission,
  extractModelPermissions,
  filterToolTiersByPermission,
  parseModelsToMap,
} from "./model-permissions";

// ============================================================================
// extractModelPermissions
// ============================================================================

describe("extractModelPermissions", () => {
  it("should return undefined for null/undefined permission", () => {
    expect(extractModelPermissions(null)).toBeUndefined();
    expect(extractModelPermissions(undefined)).toBeUndefined();
  });

  it("should return undefined when 'models' key is absent", () => {
    expect(extractModelPermissions({ self: ["PERM1"] })).toBeUndefined();
    expect(extractModelPermissions({})).toBeUndefined();
  });

  it("should return empty array when 'models' key is present but empty", () => {
    const result = extractModelPermissions({ models: [] });
    expect(result).toEqual([]);
  });

  it("should return the models array when present", () => {
    const models = ["conn:model-a", "conn:model-b"];
    expect(extractModelPermissions({ models })).toEqual(models);
  });

  it("should return wildcard array when present", () => {
    expect(extractModelPermissions({ models: ["*:*"] })).toEqual(["*:*"]);
  });
});

// ============================================================================
// checkModelPermission
// ============================================================================

describe("checkModelPermission", () => {
  const connA = "550e8400-e29b-41d4-a716-446655440000";
  const connB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const modelClaude = "anthropic/claude-sonnet-4.5";
  const modelGemini = "google/gemini-2.5-flash";
  const modelWithColon = "xiaomi/mimo-v2-flash:free";

  describe("when models is undefined (no key in permission)", () => {
    it("should allow all models (backward compat)", () => {
      expect(checkModelPermission(undefined, connA, modelClaude)).toBe(true);
      expect(checkModelPermission(undefined, connB, modelGemini)).toBe(true);
    });
  });

  describe("when models contains global wildcard *:*", () => {
    it("should allow any model from any connection", () => {
      const models = ["*:*"];
      expect(checkModelPermission(models, connA, modelClaude)).toBe(true);
      expect(checkModelPermission(models, connB, modelGemini)).toBe(true);
      expect(
        checkModelPermission(models, "unknown-conn", "unknown-model"),
      ).toBe(true);
    });
  });

  describe("when models contains connection wildcard", () => {
    it("should allow any model from that connection", () => {
      const models = [`${connA}:*`];
      expect(checkModelPermission(models, connA, modelClaude)).toBe(true);
      expect(checkModelPermission(models, connA, modelGemini)).toBe(true);
      expect(checkModelPermission(models, connA, "any-model")).toBe(true);
    });

    it("should deny models from other connections", () => {
      const models = [`${connA}:*`];
      expect(checkModelPermission(models, connB, modelClaude)).toBe(false);
    });
  });

  describe("when models contains specific entries", () => {
    it("should allow exact connectionId:modelId matches", () => {
      const models = [`${connA}:${modelClaude}`, `${connB}:${modelGemini}`];
      expect(checkModelPermission(models, connA, modelClaude)).toBe(true);
      expect(checkModelPermission(models, connB, modelGemini)).toBe(true);
    });

    it("should deny non-matching models", () => {
      const models = [`${connA}:${modelClaude}`];
      expect(checkModelPermission(models, connA, modelGemini)).toBe(false);
      expect(checkModelPermission(models, connB, modelClaude)).toBe(false);
    });

    it("should handle model IDs containing colons", () => {
      const models = [`${connA}:${modelWithColon}`];
      expect(checkModelPermission(models, connA, modelWithColon)).toBe(true);
      expect(checkModelPermission(models, connA, "xiaomi/mimo-v2-flash")).toBe(
        false,
      );
    });
  });

  describe("when models is an empty array", () => {
    it("should deny all models (fail-closed)", () => {
      expect(checkModelPermission([], connA, modelClaude)).toBe(false);
      expect(checkModelPermission([], connB, modelGemini)).toBe(false);
    });
  });

  describe("mixed wildcards and specific entries", () => {
    it("should allow via connection wildcard even without specific entry", () => {
      const models = [`${connA}:*`, `${connB}:${modelGemini}`];
      expect(checkModelPermission(models, connA, modelClaude)).toBe(true);
      expect(checkModelPermission(models, connA, "any-model")).toBe(true);
      expect(checkModelPermission(models, connB, modelGemini)).toBe(true);
      expect(checkModelPermission(models, connB, modelClaude)).toBe(false);
    });
  });
});

// ============================================================================
// filterToolTiersByPermission
// ============================================================================

describe("filterToolTiersByPermission", () => {
  const chatKey = "550e8400-e29b-41d4-a716-446655440000";
  const imageKey = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const drKey = "9c858901-8a57-4791-81d8-1041e02b3e0e";

  const sampleModels = {
    credentialId: chatKey,
    thinking: { id: "claude-opus-4-5" },
    image: { credentialId: imageKey, id: "gpt-image-1" },
    deepResearch: {
      credentialId: drKey,
      id: "deep-research-pro-preview-12-2025",
    },
  };

  it("returns models unchanged when allowedModels is undefined (admin/owner)", () => {
    const result = filterToolTiersByPermission(undefined, sampleModels);
    expect(result).toBe(sampleModels);
  });

  it("keeps image tier when its (key, model) is permitted", () => {
    const allowed = [
      `${chatKey}:claude-opus-4-5`,
      `${imageKey}:gpt-image-1`,
      `${drKey}:deep-research-pro-preview-12-2025`,
    ];
    const result = filterToolTiersByPermission(allowed, sampleModels);
    expect(result.image).toEqual(sampleModels.image);
    expect(result.deepResearch).toEqual(sampleModels.deepResearch);
  });

  it("strips image tier when its key is not permitted at all", () => {
    const allowed = [
      `${chatKey}:claude-opus-4-5`,
      `${drKey}:deep-research-pro-preview-12-2025`,
    ];
    const result = filterToolTiersByPermission(allowed, sampleModels);
    expect(result.image).toBeUndefined();
    expect(result.deepResearch).toEqual(sampleModels.deepResearch);
  });

  it("strips deepResearch tier when only its modelId is not permitted", () => {
    const allowed = [
      `${chatKey}:*`,
      `${imageKey}:gpt-image-1`,
      `${drKey}:some-other-model`,
    ];
    const result = filterToolTiersByPermission(allowed, sampleModels);
    expect(result.image).toEqual(sampleModels.image);
    expect(result.deepResearch).toBeUndefined();
  });

  it("strips both tiers when neither is permitted", () => {
    const allowed = [`${chatKey}:claude-opus-4-5`];
    const result = filterToolTiersByPermission(allowed, sampleModels);
    expect(result.image).toBeUndefined();
    expect(result.deepResearch).toBeUndefined();
    expect(result.thinking).toEqual(sampleModels.thinking);
    expect(result.credentialId).toBe(sampleModels.credentialId);
  });

  it("does not filter the chat (thinking) slot — caller throws for that", () => {
    const allowed = [`${imageKey}:gpt-image-1`];
    const result = filterToolTiersByPermission(allowed, sampleModels);
    expect(result.thinking).toEqual(sampleModels.thinking);
  });

  it("treats *:* as allow-all and keeps every tier", () => {
    const result = filterToolTiersByPermission(["*:*"], sampleModels);
    expect(result.image).toEqual(sampleModels.image);
    expect(result.deepResearch).toEqual(sampleModels.deepResearch);
  });
});

// ============================================================================
// parseModelsToMap
// ============================================================================

describe("parseModelsToMap", () => {
  const connA = "550e8400-e29b-41d4-a716-446655440000";
  const connB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  it("should return allowAll when models is undefined", () => {
    const result = parseModelsToMap(undefined);
    expect(result).toEqual({ allowAll: true, models: {} });
  });

  it("should return allowAll when models contains *:*", () => {
    const result = parseModelsToMap(["*:*"]);
    expect(result).toEqual({ allowAll: true, models: {} });
  });

  it("should return allowAll when *:* is among other entries", () => {
    const result = parseModelsToMap([`${connA}:model-1`, "*:*"]);
    expect(result).toEqual({ allowAll: true, models: {} });
  });

  it("should parse specific entries into connection-scoped map", () => {
    const models = [
      `${connA}:anthropic/claude-sonnet-4.5`,
      `${connA}:google/gemini-2.5-flash`,
      `${connB}:deepseek/deepseek-v3`,
    ];
    const result = parseModelsToMap(models);
    expect(result.allowAll).toBe(false);
    expect(result.models[connA]).toEqual([
      "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-flash",
    ]);
    expect(result.models[connB]).toEqual(["deepseek/deepseek-v3"]);
  });

  it("should handle connection wildcard entries", () => {
    const models = [`${connA}:*`];
    const result = parseModelsToMap(models);
    expect(result.allowAll).toBe(false);
    expect(result.models[connA]).toEqual(["*"]);
  });

  it("should handle model IDs containing colons", () => {
    const models = [`${connA}:xiaomi/mimo-v2-flash:free`];
    const result = parseModelsToMap(models);
    expect(result.allowAll).toBe(false);
    expect(result.models[connA]).toEqual(["xiaomi/mimo-v2-flash:free"]);
  });

  it("should skip malformed entries without colons", () => {
    const models = ["no-colon-here", `${connA}:valid-model`];
    const result = parseModelsToMap(models);
    expect(result.allowAll).toBe(false);
    expect(Object.keys(result.models)).toEqual([connA]);
    expect(result.models[connA]).toEqual(["valid-model"]);
  });

  it("should return empty map for empty array", () => {
    const result = parseModelsToMap([]);
    expect(result).toEqual({ allowAll: false, models: {} });
  });
});
