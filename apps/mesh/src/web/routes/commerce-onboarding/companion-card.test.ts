import { describe, expect, it } from "bun:test";
import { maskConfigValue } from "./companion-card.tsx";

describe("maskConfigValue", () => {
  it("masks keys ending in token, secret, password, appKey, or key", () => {
    expect(maskConfigValue("appToken", "abc123")).toBe("••••••••");
    expect(maskConfigValue("clientSecret", "abc123")).toBe("••••••••");
    expect(maskConfigValue("password", "abc123")).toBe("••••••••");
    expect(maskConfigValue("appKey", "abc123")).toBe("••••••••");
    expect(maskConfigValue("accessKey", "abc123")).toBe("••••••••");
  });

  it("is case-insensitive", () => {
    expect(maskConfigValue("ACCESSTOKEN", "abc123")).toBe("••••••••");
    expect(maskConfigValue("Api_Secret", "abc123")).toBe("••••••••");
  });

  it("does not mask non-sensitive keys", () => {
    expect(maskConfigValue("siteUrl", "https://example.com")).toBe(
      "https://example.com",
    );
    expect(maskConfigValue("propertyId", "12345")).toBe("12345");
    expect(maskConfigValue("accountName", "Acme")).toBe("Acme");
  });

  it("only matches the sensitive term at the end of the key", () => {
    expect(maskConfigValue("keyholder", "abc123")).toBe("abc123");
    expect(maskConfigValue("tokenizer", "abc123")).toBe("abc123");
  });
});
