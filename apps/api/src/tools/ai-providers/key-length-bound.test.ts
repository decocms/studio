import { describe, expect, test } from "bun:test";
import { AI_PROVIDER_KEY_CREATE } from "./key-create";
import { AI_PROVIDER_KEY_UPDATE } from "./key-update";

describe("AI provider key apiKey length bound", () => {
  test("AI_PROVIDER_KEY_CREATE rejects an oversized apiKey", () => {
    expect(
      AI_PROVIDER_KEY_CREATE.inputSchema.safeParse({
        providerId: "deco",
        label: "Provider key",
        apiKey: "a".repeat(4097),
      }).success,
    ).toBeFalse();
  });

  test("AI_PROVIDER_KEY_CREATE accepts a key at the bound", () => {
    expect(
      AI_PROVIDER_KEY_CREATE.inputSchema.safeParse({
        providerId: "deco",
        label: "Provider key",
        apiKey: "a".repeat(4096),
      }).success,
    ).toBeTrue();
  });

  test("AI_PROVIDER_KEY_UPDATE rejects an oversized apiKey", () => {
    expect(
      AI_PROVIDER_KEY_UPDATE.inputSchema.safeParse({
        keyId: "key_1",
        apiKey: "a".repeat(4097),
      }).success,
    ).toBeFalse();
  });
});
