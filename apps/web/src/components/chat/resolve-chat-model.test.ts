import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_TIER } from "@decocms/shared/organization/schema";
import { chosenChatTier, resolveActiveTier } from "./resolve-chat-model";

describe("chat tier preference", () => {
  test("a stored tier is the person's choice where the picker renders", () => {
    for (const tier of ["fast", "smart", "thinking"] as const) {
      expect(chosenChatTier(tier, true)).toBe(tier);
      expect(resolveActiveTier(chosenChatTier(tier, true))).toBe(tier);
    }
  });

  test("without the picker a stored tier is not a choice", () => {
    for (const stored of ["fast", "smart", "thinking"]) {
      expect(chosenChatTier(stored, false)).toBeNull();
      expect(resolveActiveTier(chosenChatTier(stored, false))).toBe(
        DEFAULT_CHAT_TIER,
      );
    }
  });

  test("nothing stored, or a value that is not a chat tier, is no choice", () => {
    for (const stored of [null, undefined, "", "image", "Smart", 3]) {
      expect(chosenChatTier(stored, true)).toBeNull();
    }
    expect(resolveActiveTier(null)).toBe(DEFAULT_CHAT_TIER);
  });
});
