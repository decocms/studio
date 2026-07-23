import { afterEach, describe, expect, it } from "bun:test";
import { isVaultServiceToken, safeEqual } from "./credential-vault";

describe("safeEqual", () => {
  it("matches equal strings and rejects different ones (incl. different lengths — no throw)", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false); // length guard, timingSafeEqual would throw otherwise
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("isVaultServiceToken", () => {
  const prev = process.env.VAULT_SERVICE_TOKEN;
  afterEach(() => {
    if (prev === undefined) delete process.env.VAULT_SERVICE_TOKEN;
    else process.env.VAULT_SERVICE_TOKEN = prev;
  });

  it("is off when the env var is unset", () => {
    delete process.env.VAULT_SERVICE_TOKEN;
    expect(isVaultServiceToken("anything")).toBe(false);
  });

  it("accepts the configured token, rejects others", () => {
    process.env.VAULT_SERVICE_TOKEN = "svc-secret";
    expect(isVaultServiceToken("svc-secret")).toBe(true);
    expect(isVaultServiceToken("wrong")).toBe(false);
    expect(isVaultServiceToken("")).toBe(false);
  });
});
