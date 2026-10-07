import { describe, expect, it } from "bun:test";
import type { Denylist } from "./denylist";
import { memoryKv } from "./hosted-test-helpers";
import {
  createSiteTokens,
  importSigningKey,
  SiteTokenNotFoundError,
  TooManySiteTokensError,
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

function setup(pkcs8: string) {
  const denied: string[] = [];
  const denylist: Denylist = {
    get: async () => null,
    put: async (key) => {
      denied.push(key);
    },
    delete: async () => {},
  };
  const tokens = createSiteTokens({
    kv: memoryKv(),
    signingKey: () => importSigningKey(pkcs8),
    denylist,
  });
  return { tokens, denied };
}

describe("site tokens", () => {
  it("issues an EdDSA JWS of {site, kid, iat} the edge can verify", async () => {
    const { pkcs8, publicKey } = await keyPair();
    const { tokens } = setup(pkcs8);
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

  it("refuses a third active token, and allows one again after a revoke", async () => {
    const { pkcs8 } = await keyPair();
    const { tokens, denied } = setup(pkcs8);
    const a = await tokens.issue("org", "acme");
    await tokens.issue("org", "acme");
    await expect(tokens.issue("org", "acme")).rejects.toThrow(
      TooManySiteTokensError,
    );
    const revoked = await tokens.revoke("org", "acme", a.record.kid);
    expect(revoked.revokedAt).toBeString();
    expect(denied).toEqual([`revoked:${a.record.kid}`]);
    await tokens.issue("org", "acme");
    expect(await tokens.list("org", "acme")).toHaveLength(3);
  });

  it("keeps a token active when the denylist write fails", async () => {
    const { pkcs8 } = await keyPair();
    const kv = memoryKv();
    const tokens = createSiteTokens({
      kv,
      signingKey: () => importSigningKey(pkcs8),
      denylist: {
        get: async () => null,
        put: async () => {
          throw new Error("KV down");
        },
        delete: async () => {},
      },
    });
    const { record } = await tokens.issue("org", "acme");
    await expect(tokens.revoke("org", "acme", record.kid)).rejects.toThrow();
    expect((await tokens.list("org", "acme"))[0]?.revokedAt).toBeUndefined();
  });

  it("answers not found for another site's kid", async () => {
    const { pkcs8 } = await keyPair();
    const { tokens } = setup(pkcs8);
    const { record } = await tokens.issue("org", "acme");
    await expect(tokens.revoke("org", "other", record.kid)).rejects.toThrow(
      SiteTokenNotFoundError,
    );
  });
});
