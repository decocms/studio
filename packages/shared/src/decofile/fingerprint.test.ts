import { describe, expect, it } from "bun:test";
import { canonicalBlockJson, decoBlockFingerprint } from "./fingerprint";
import { PlaintextSecretError } from "./secret";

describe("canonicalBlockJson", () => {
  it("sorts keys at every depth", () => {
    expect(canonicalBlockJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it("matches the JSON round trip of the same value", () => {
    const value = { keep: 1, gone: undefined, list: [1, undefined, "x"] };
    expect(canonicalBlockJson(value)).toBe(
      canonicalBlockJson(JSON.parse(JSON.stringify(value))),
    );
  });
});

describe("decoBlockFingerprint", () => {
  it("ignores key order", async () => {
    expect(await decoBlockFingerprint({ a: 1, b: [2, 3] })).toBe(
      await decoBlockFingerprint({ b: [2, 3], a: 1 }),
    );
  });

  it("changes when any nested value changes", async () => {
    expect(
      await decoBlockFingerprint({ menu: [{ label: "SS Rio 26/27" }] }),
    ).not.toBe(
      await decoBlockFingerprint({ menu: [{ label: "SSRio 26/27" }] }),
    );
  });

  it("hashes the persisted form of a secret, without the transient value", async () => {
    const stored = {
      __resolveType: "website/loaders/secret.ts",
      name: "API_KEY",
      encrypted: "a1b2",
    };
    expect(await decoBlockFingerprint({ ...stored, value: "typed" })).toBe(
      await decoBlockFingerprint(stored),
    );
  });

  it("refuses a plaintext secret", async () => {
    await expect(
      decoBlockFingerprint({
        __resolveType: "website/loaders/secret.ts",
        encrypted: "not hex",
      }),
    ).rejects.toBeInstanceOf(PlaintextSecretError);
  });

  it("is a sha-256 hex digest", async () => {
    expect(await decoBlockFingerprint(null)).toMatch(/^[0-9a-f]{64}$/);
  });
});
