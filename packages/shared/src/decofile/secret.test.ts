import { describe, expect, it } from "bun:test";
import {
  isEncryptedSecretValue,
  isSecretBlock,
  PlaintextSecretError,
  sanitizeSecretsForPersistence,
} from "./secret";

const RAW = "SG.synthetic-raw-api-key_0123456789";
const HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

function page(secret: Record<string, unknown>) {
  return {
    __resolveType: "website/pages/Page.tsx",
    sections: [
      {
        __resolveType: "site/sections/Form.tsx",
        sendGridApiKey: {
          __resolveType: "website/loaders/secret.ts",
          name: "SENDGRID_API_KEY",
          ...secret,
        },
      },
    ],
  };
}

describe("isSecretBlock", () => {
  it("detects secret loader blocks, not strings or other blocks", () => {
    expect(isSecretBlock({ __resolveType: "website/loaders/secret.ts" })).toBe(
      true,
    );
    expect(isSecretBlock({ __resolveType: "$live/loaders/secret.ts" })).toBe(
      true,
    );
    expect(isSecretBlock("secret")).toBe(false);
    expect(isSecretBlock({ __resolveType: "site/sections/Hero.tsx" })).toBe(
      false,
    );
    expect(isSecretBlock(null)).toBe(false);
    expect(isSecretBlock([])).toBe(false);
  });
});

describe("isEncryptedSecretValue", () => {
  it("accepts hex and empty, rejects raw secrets and odd-length hex", () => {
    expect(isEncryptedSecretValue(HEX)).toBe(true);
    expect(isEncryptedSecretValue("")).toBe(true);
    expect(isEncryptedSecretValue(RAW)).toBe(false);
    expect(isEncryptedSecretValue("abc")).toBe(false);
    expect(isEncryptedSecretValue(42)).toBe(false);
  });
});

describe("sanitizeSecretsForPersistence", () => {
  it("keeps encrypted and empty secrets and unrelated data unchanged", () => {
    expect(sanitizeSecretsForPersistence(page({ encrypted: HEX }))).toEqual(
      page({ encrypted: HEX }),
    );
    expect(sanitizeSecretsForPersistence(page({ encrypted: "" }))).toEqual(
      page({ encrypted: "" }),
    );
    expect(sanitizeSecretsForPersistence(page({}))).toEqual(page({}));
    expect(sanitizeSecretsForPersistence({ title: RAW })).toEqual({
      title: RAW,
    });
  });

  it("strips the transient plaintext value older editors attached", () => {
    const written = JSON.stringify(
      sanitizeSecretsForPersistence(page({ encrypted: HEX, value: RAW })),
    );
    expect(written).not.toContain(RAW);
    expect(written).toContain(HEX);
  });

  it("fails closed on a raw secret stored in encrypted", () => {
    expect(() =>
      sanitizeSecretsForPersistence(page({ encrypted: RAW })),
    ).toThrow(PlaintextSecretError);
    expect(() =>
      sanitizeSecretsForPersistence({
        set: { "pages-x": page({ encrypted: RAW }) },
      }),
    ).toThrow("/set/pages-x/sections/0/sendGridApiKey");
  });

  it("fails closed on a non-string encrypted value", () => {
    expect(() =>
      sanitizeSecretsForPersistence(page({ encrypted: { raw: RAW } })),
    ).toThrow(PlaintextSecretError);
  });
});
