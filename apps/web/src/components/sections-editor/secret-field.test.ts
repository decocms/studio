import { describe, expect, test } from "bun:test";
import { isSecretBlock } from "./fields/secret-field";

describe("isSecretBlock", () => {
  test("detects website secret loader blocks", () => {
    expect(
      isSecretBlock({
        __resolveType: "website/loaders/secret.ts",
        name: "apiKey",
        encrypted: "abc",
      }),
    ).toBe(true);
  });

  test("rejects plain strings and unrelated objects", () => {
    expect(isSecretBlock("secret")).toBe(false);
    expect(isSecretBlock({ __resolveType: "site/sections/Hero.tsx" })).toBe(
      false,
    );
    expect(isSecretBlock(null)).toBe(false);
  });
});
