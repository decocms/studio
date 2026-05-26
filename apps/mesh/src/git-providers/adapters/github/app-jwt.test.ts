import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { buildAppJwt } from "./app-jwt";

/**
 * Verify the JWT we emit is RS256-signed and structurally correct so GitHub
 * actually accepts it. We sign with a freshly-generated RSA key, then split
 * the resulting JWT, base64url-decode the payload, and verify the signature.
 */
describe("buildAppJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  test("emits a structurally valid RS256 JWT", () => {
    const jwt = buildAppJwt({
      appId: "12345",
      privateKeyPem,
    });

    const parts = jwt.split(".") as [string, string, string];
    expect(parts).toHaveLength(3);

    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf-8"),
    );
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    );
    expect(payload.iss).toBe("12345");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");

    // exp is within 10 minutes of now (we use 9 min)
    const now = Math.floor(Date.now() / 1000);
    expect(payload.exp - now).toBeGreaterThan(60);
    expect(payload.exp - now).toBeLessThanOrEqual(9 * 60);

    // iat is backdated 60s to absorb clock skew
    expect(now - payload.iat).toBeGreaterThanOrEqual(60);
    expect(now - payload.iat).toBeLessThan(70);
  });

  test("signature verifies against the public key", () => {
    const jwt = buildAppJwt({
      appId: "12345",
      privateKeyPem,
    });

    const [encHeader, encPayload, encSig] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encHeader}.${encPayload}`);
    verifier.end();
    const ok = verifier.verify(publicKey, Buffer.from(encSig, "base64url"));
    expect(ok).toBe(true);
  });
});
