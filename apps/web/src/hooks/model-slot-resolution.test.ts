import { describe, expect, test } from "bun:test";
import type { SimpleModeDefaults } from "@decocms/shared/sdk";
import type { SimpleModeConfig } from "./use-organization-settings";
import {
  firstAvailableModelSlot,
  resolveEffectiveSimpleMode,
  type ModelTierPreferences,
} from "./model-slot-resolution";

const org: SimpleModeConfig = {
  tiers: {
    fast: { keyId: "hosted", modelId: "org-fast" },
    smart: { keyId: "hosted", modelId: "org-smart" },
    thinking: null,
    image: { keyId: "retired", modelId: "old-image" },
    web_search: null,
    deep_research: null,
  },
};

const noDefaults: SimpleModeDefaults = {
  chat: { fast: null, smart: null, thinking: null },
  image: null,
  webSearch: null,
  deepResearch: null,
};

describe("hosted model-slot resolution", () => {
  test("selects the first slot backed by an available hosted key", () => {
    expect(
      firstAvailableModelSlot(
        [
          { keyId: "retired", modelId: "codex:gpt-5.6-terra" },
          { keyId: "hosted", modelId: "claude-sonnet-5" },
        ],
        new Set(["hosted"]),
      ),
    ).toEqual({ keyId: "hosted", modelId: "claude-sonnet-5" });
  });

  test("falls through a stale user override to the live org slot", () => {
    const user: ModelTierPreferences = {
      tiers: {
        fast: { keyId: "retired", modelId: "claude-code:haiku" },
        smart: { keyId: "hosted", modelId: "user-smart" },
      },
    };

    expect(
      resolveEffectiveSimpleMode(org, user, new Set(["hosted"]), noDefaults),
    ).toEqual({
      tiers: {
        fast: { keyId: "hosted", modelId: "org-fast" },
        smart: { keyId: "hosted", modelId: "user-smart" },
        thinking: null,
        image: null,
        web_search: null,
        deep_research: null,
      },
    });
  });

  test("an unset or stale org slot resolves to the default pick", () => {
    const defaults: SimpleModeDefaults = {
      chat: {
        fast: { keyId: "hosted", modelId: "default-fast" },
        smart: { keyId: "hosted", modelId: "default-smart" },
        thinking: { keyId: "hosted", modelId: "default-thinking" },
      },
      image: { keyId: "hosted", modelId: "default-image" },
      webSearch: { keyId: "hosted", modelId: "default-search" },
      deepResearch: null,
    };

    expect(
      resolveEffectiveSimpleMode(
        org,
        { tiers: {} },
        new Set(["hosted"]),
        defaults,
      ),
    ).toEqual({
      tiers: {
        fast: { keyId: "hosted", modelId: "org-fast" },
        smart: { keyId: "hosted", modelId: "org-smart" },
        thinking: { keyId: "hosted", modelId: "default-thinking" },
        image: { keyId: "hosted", modelId: "default-image" },
        web_search: { keyId: "hosted", modelId: "default-search" },
        deep_research: null,
      },
    });
  });
});
