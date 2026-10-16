import { describe, expect, it } from "bun:test";
import {
  blockMetaOf,
  canonicalBlockJson,
  decoBlockFingerprint,
  stampBlockMeta,
} from "./fingerprint";
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

describe("block metadata (__meta)", () => {
  const block = { __resolveType: "hero", title: "Hi" };
  const meta = {
    lastEditedBy: "u-ana",
    lastEditedAt: "2026-10-16T12:00:00.000Z",
  };

  it("isn't content: canonical JSON and fingerprints ignore it", async () => {
    const stamped = { ...block, __meta: meta };
    expect(canonicalBlockJson(stamped)).toBe(canonicalBlockJson(block));
    expect(await decoBlockFingerprint(stamped)).toBe(
      await decoBlockFingerprint(block),
    );
    expect(
      await decoBlockFingerprint({
        ...block,
        __meta: { ...meta, lastEditedBy: "u-bob" },
      }),
    ).toBe(await decoBlockFingerprint(stamped));
    // Content still counts.
    expect(canonicalBlockJson({ ...stamped, title: "Bye" })).not.toBe(
      canonicalBlockJson(stamped),
    );
  });

  it("stamps the saving user and time, replacing an earlier record", () => {
    const old = { ...block, __meta: { ...meta, lastEditedBy: "u-bob" } };
    expect(stampBlockMeta(old, "u-ana", meta.lastEditedAt)).toEqual({
      ...block,
      __meta: meta,
    });
    expect(old.__meta.lastEditedBy).toBe("u-bob"); // not mutated
  });

  it("without a user, drops an earlier record instead of keeping a wrong one", () => {
    expect(stampBlockMeta({ ...block, __meta: meta }, null, "x")).toEqual(
      block,
    );
    expect(stampBlockMeta("literal", "u-ana", "x")).toBe("literal");
    expect(stampBlockMeta(["a"], "u-ana", "x")).toEqual(["a"]);
  });

  it("reads a well-formed record only", () => {
    expect(blockMetaOf({ ...block, __meta: meta })).toEqual(meta);
    expect(blockMetaOf(block)).toBeNull();
    expect(
      blockMetaOf({ __meta: { lastEditedBy: "u", lastEditedAt: "soon" } }),
    ).toBeNull();
    expect(
      blockMetaOf({
        __meta: { lastEditedBy: "", lastEditedAt: meta.lastEditedAt },
      }),
    ).toBeNull();
  });
});
