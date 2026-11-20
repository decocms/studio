import { describe, expect, it } from "bun:test";
import { memoryKv } from "./hosted-test-helpers";
import type { KVStorage } from "@/storage/kv";
import {
  createSiteTokens,
  importSigningKey,
  importVerifyKey,
  verifySiteToken,
} from "./site-token";

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = Buffer.from(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ).toString("base64");
  return { pkcs8, publicKey: pair.publicKey };
}

function setup(pkcs8: string, kv: KVStorage = memoryKv()) {
  return createSiteTokens({
    kv,
    signingKey: () => importSigningKey(pkcs8),
  });
}

describe("site tokens", () => {
  it("issues an EdDSA JWS of {site, kid, iat} the edge can verify", async () => {
    const { pkcs8, publicKey } = await keyPair();
    const tokens = setup(pkcs8);
    const { token, record } = await tokens.issue("org", "acme");
    const [h, p, sig] = token.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
      alg: "EdDSA",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({
      site: "acme",
      kid: record.kid,
      iat: record.iat,
    });
    expect(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        publicKey,
        Buffer.from(sig!, "base64url"),
        new TextEncoder().encode(`${h}.${p}`),
      ),
    ).toBe(true);
    expect(await tokens.list("org", "acme")).toEqual([record]);
    expect(JSON.stringify(await tokens.list("org", "acme"))).not.toContain(
      sig!,
    );
  });

  it("issues as many tokens as asked, each listed by kid", async () => {
    const { pkcs8 } = await keyPair();
    const tokens = setup(pkcs8);
    const issued = [];
    for (let i = 0; i < 4; i++) issued.push(await tokens.issue("org", "acme"));
    expect(new Set(issued.map((i) => i.record.kid)).size).toBe(4);
    expect(await tokens.list("org", "acme")).toEqual(
      issued.map((i) => i.record),
    );
    expect(await tokens.list("org", "other")).toEqual([]);
  });

  it("verifies its own tokens from the signing key's public half", async () => {
    const { pkcs8 } = await keyPair();
    const { token, record } = await setup(pkcs8).issue("org", "acme");
    const key = await importVerifyKey(pkcs8);
    expect(await verifySiteToken(key, token)).toEqual({
      site: "acme",
      kid: record.kid,
      iat: record.iat,
    });
  });

  it("verifies nothing else", async () => {
    const { pkcs8 } = await keyPair();
    const other = await keyPair();
    const key = await importVerifyKey(pkcs8);
    const { token } = await setup(pkcs8).issue("org", "acme");
    const { token: foreign } = await setup(other.pkcs8).issue("org", "acme");
    const [h, p, sig] = token.split(".") as [string, string, string];
    const enc = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    for (const bad of [
      foreign,
      `${h}.${enc({ ...claims, site: "beta" })}.${sig}`,
      `${enc({ alg: "none" })}.${p}.${sig}`,
      `${h}.${enc({ site: "acme", kid: claims.kid })}.${sig}`,
      `${h}.${p}.`,
      `${h}.${p}`,
      `${h}.${p}.${sig}.x`,
      `${h}.${p}.${sig}!`,
      `${h}.${p}.${sig}${"A".repeat(2048)}`,
      "",
    ]) {
      expect(await verifySiteToken(key, bad)).toBeNull();
    }
  });

  it("revokes by kid: no longer live or listed, and a second revoke is false", async () => {
    const { pkcs8 } = await keyPair();
    const tokens = setup(pkcs8);
    const a = await tokens.issue("org", "acme");
    const b = await tokens.issue("org", "acme");
    expect(await tokens.isLive("org", "acme", a.record.kid)).toBe(true);
    expect(await tokens.revoke("org", "acme", a.record.kid)).toBe(true);
    expect(await tokens.isLive("org", "acme", a.record.kid)).toBe(false);
    expect(await tokens.isLive("org", "acme", b.record.kid)).toBe(true);
    expect(await tokens.list("org", "acme")).toEqual([b.record]);
    expect(await tokens.revoke("org", "acme", a.record.kid)).toBe(false);
    expect(await tokens.revoke("org", "acme", "unknown")).toBe(false);
    // Scoped to the org and the site.
    expect(await tokens.revoke("org", "beta", b.record.kid)).toBe(false);
    expect(await tokens.isLive("other", "acme", b.record.kid)).toBe(false);
  });

  it("stays revoked when an issue racing the revoke writes the old record back", async () => {
    const { pkcs8 } = await keyPair();
    const kv = memoryKv();
    const tokens = setup(pkcs8, kv);
    const a = await tokens.issue("org", "acme");
    const stale = await kv.get("org", "site-tokens:acme");
    await tokens.revoke("org", "acme", a.record.kid);
    // The racing issue read the list before the revoke and writes it back.
    await kv.set("org", "site-tokens:acme", stale!);
    expect(await tokens.isLive("org", "acme", a.record.kid)).toBe(false);
    expect(await tokens.list("org", "acme")).toEqual([]);
  });
});
