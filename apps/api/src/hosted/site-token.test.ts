import { describe, expect, it } from "bun:test";
import { memoryKv } from "./hosted-test-helpers";
import { createSiteTokens, importSigningKey } from "./site-token";

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

function setup(pkcs8: string) {
  return createSiteTokens({
    kv: memoryKv(),
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
});
