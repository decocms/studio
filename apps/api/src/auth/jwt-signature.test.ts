import { describe, expect, it } from "bun:test";
import { importJWK, jwtVerify } from "jose";
import { getProxyTokenJwks, signProxyToken } from "./jwt-signature";

describe("jwt-signature", () => {
  it("signs a token verifiable with the published JWKS, scoped to its audience", async () => {
    const token = await signProxyToken({ sub: "user_123" }, "conn_456");
    const jwks = await getProxyTokenJwks();

    expect(jwks.keys).toHaveLength(1);
    const [jwk] = jwks.keys;
    if (!jwk) throw new Error("expected a published key");
    const key = await importJWK(jwk, "EdDSA");

    const { payload, protectedHeader } = await jwtVerify(token, key, {
      issuer: "studio",
      audience: "conn_456",
    });

    expect(payload.sub).toBe("user_123");
    expect(protectedHeader.kid).toBe(jwk.kid);
  });

  it("rejects verification against a different connection's audience", async () => {
    const token = await signProxyToken({ sub: "user_123" }, "conn_456");
    const jwks = await getProxyTokenJwks();
    const [jwk] = jwks.keys;
    if (!jwk) throw new Error("expected a published key");
    const key = await importJWK(jwk, "EdDSA");

    await expect(
      jwtVerify(token, key, { issuer: "studio", audience: "conn_other" }),
    ).rejects.toThrow();
  });
});
