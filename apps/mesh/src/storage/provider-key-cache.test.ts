import { describe, expect, it } from "bun:test";
import {
  createProviderKeyCache,
  type ProviderKeyCacheEntry,
} from "./provider-key-cache";

function entry(label: string): ProviderKeyCacheEntry {
  return {
    keyInfo: {
      id: "aik_1",
      providerId: "openai-compatible",
      label,
      presetId: null,
      organizationId: "org_1",
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
    },
    encryptedApiKey: "ciphertext",
  };
}

describe("createProviderKeyCache (local-only)", () => {
  it("returns set entries", () => {
    const cache = createProviderKeyCache();
    cache.set("org_1", "aik_1", entry("a"));
    expect(cache.get("org_1", "aik_1")?.keyInfo.label).toBe("a");
  });

  it("scopes entries by org + key id", () => {
    const cache = createProviderKeyCache();
    cache.set("org_1", "aik_1", entry("a"));
    expect(cache.get("org_2", "aik_1")).toBeUndefined();
    expect(cache.get("org_1", "aik_2")).toBeUndefined();
  });

  it("invalidate evicts the entry locally", () => {
    const cache = createProviderKeyCache();
    cache.set("org_1", "aik_1", entry("a"));
    cache.invalidate("org_1", "aik_1");
    expect(cache.get("org_1", "aik_1")).toBeUndefined();
  });

  it("start and teardown are safe without a NATS connection", () => {
    const cache = createProviderKeyCache();
    expect(() => cache.start()).not.toThrow();
    cache.set("org_1", "aik_1", entry("a"));
    cache.teardown();
    expect(cache.get("org_1", "aik_1")).toBeUndefined();
  });
});
