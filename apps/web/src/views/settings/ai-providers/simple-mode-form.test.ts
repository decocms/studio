import { describe, expect, test } from "bun:test";
import {
  pickSimpleModeDefaults,
  simpleModeDefaultSlot,
  type AiProviderKey,
  type AiProviderModel,
} from "@decocms/shared/sdk";
import { SimpleModeTierSchema } from "@decocms/shared/organization/schema";
import type { SimpleModeConfig } from "@/hooks/use-organization-settings";
import { simpleModeToPersist, tierDisplay } from "./simple-mode-form";

const key: AiProviderKey = {
  id: "live-key",
  providerId: "openrouter",
  label: "Provider",
  presetId: null,
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function model(
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

const catalog = [
  model("anthropic/claude-haiku-4.5", ["text"]),
  model("anthropic/claude-sonnet-5", ["text"]),
  model("anthropic/claude-opus-4.8", ["text", "reasoning"]),
  model("google/gemini-3-pro-image", ["image"]),
  model("perplexity/sonar", ["text"]),
  model("perplexity/deep-research", ["text"]),
];

const defaults = pickSimpleModeDefaults([key], { [key.id]: catalog });
const liveKeys = new Set([key.id]);
const tiers = SimpleModeTierSchema.options;

const unset: SimpleModeConfig = {
  tiers: {
    fast: null,
    smart: null,
    thinking: null,
    image: null,
    web_search: null,
    deep_research: null,
  },
};

const chosen = { keyId: key.id, modelId: "some/model", title: "Some model" };

describe("simple mode form", () => {
  test("the catalog has a default for every tier", () => {
    for (const tier of tiers) {
      expect(simpleModeDefaultSlot(defaults, tier)).not.toBeNull();
    }
  });

  test("changing one tier leaves every unset tier null", () => {
    const form = { tiers: { ...unset.tiers, smart: chosen } };

    expect(simpleModeToPersist(form, liveKeys)).toEqual({
      tiers: { ...unset.tiers, smart: chosen },
    });
  });

  test("returning a chosen tier to the default stores null", () => {
    const form = { tiers: { ...unset.tiers, smart: chosen, fast: chosen } };
    const cleared = { tiers: { ...form.tiers, smart: null } };

    expect(simpleModeToPersist(cleared, liveKeys).tiers).toEqual({
      ...unset.tiers,
      fast: chosen,
    });
    expect(tierDisplay("smart", null, defaults, liveKeys).followsDefault).toBe(
      true,
    );
  });

  test("a slot whose provider key is gone is cleared, the others kept", () => {
    const stale = { keyId: "deleted-key", modelId: "old/model" };
    const form = { tiers: { ...unset.tiers, fast: chosen, image: stale } };

    expect(simpleModeToPersist(form, liveKeys).tiers).toEqual({
      ...unset.tiers,
      fast: chosen,
    });
    expect(tierDisplay("image", stale, defaults, liveKeys)).toEqual({
      slot: defaults.image,
      followsDefault: true,
    });
  });

  test("an unset tier shows the model the server resolves it to", () => {
    for (const tier of tiers) {
      expect(tierDisplay(tier, null, defaults, liveKeys)).toEqual({
        slot: simpleModeDefaultSlot(defaults, tier),
        followsDefault: true,
      });
    }
  });

  test("a chosen tier shows the choice, not the default", () => {
    expect(tierDisplay("smart", chosen, defaults, liveKeys)).toEqual({
      slot: chosen,
      followsDefault: false,
    });
  });

  test("an unset tier with no model anywhere shows nothing", () => {
    const none = pickSimpleModeDefaults([key], { [key.id]: [] });

    expect(tierDisplay("image", null, none, liveKeys)).toEqual({
      slot: null,
      followsDefault: true,
    });
  });
});
