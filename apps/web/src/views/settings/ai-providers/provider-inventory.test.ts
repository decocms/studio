import { describe, expect, test } from "bun:test";
import type { AiProviderInfo, AiProviderKey } from "@/sdk";
import {
  buildProviderInventoryRows,
  getProviderInventoryState,
} from "./provider-inventory";

function key(
  id: string,
  providerId: AiProviderKey["providerId"],
): AiProviderKey {
  return {
    id,
    providerId,
    label: `${providerId} key`,
    presetId: null,
    createdBy: "user-1",
    createdAt: "2026-08-03T00:00:00.000Z",
  };
}

const anthropic: AiProviderInfo = {
  id: "anthropic",
  name: "Anthropic",
  description: "Anthropic models",
  supportedMethods: ["api-key"],
};

describe("AI provider inventory", () => {
  test("keeps legacy credentials in inventory without treating them as hosted", () => {
    const keys = [key("claude", "claude-code"), key("codex", "codex")];

    expect(getProviderInventoryState(keys)).toEqual({
      hasInventory: true,
      hasHostedProvider: false,
      hasDeco: false,
    });
  });

  test("keeps rows whose provider metadata is absent from the hosted catalog", () => {
    const anthropicKey = key("anthropic", "anthropic");
    const claudeKey = key("claude", "claude-code");
    const codexKey = key("codex", "codex");
    const keys = [anthropicKey, claudeKey, codexKey];

    expect(buildProviderInventoryRows(keys, [anthropic])).toEqual([
      { key: anthropicKey, provider: anthropic },
      { key: claudeKey, provider: null },
      { key: codexKey, provider: null },
    ]);
  });

  test("keeps Deco in its dedicated section", () => {
    expect(buildProviderInventoryRows([key("deco", "deco")], [])).toEqual([]);
  });
});
