import { describe, expect, test } from "bun:test";
import {
  decodeBase64Url,
  encryptToCiphertext,
  parseCiphertext,
  publicKeyPemFromDer,
} from "@decocms/shared/blocks-protocol";
import { protocolSecretState } from "./protocol-secret";

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  return { privateKey: pair.privateKey, publicKey: publicKeyPemFromDer(spki) };
}

async function decrypt(privateKey: CryptoKey, ciphertext: string) {
  const parts = parseCiphertext(ciphertext)!;
  const raw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    parts.wrappedKey as BufferSource,
  );
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "decrypt",
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: parts.iv as BufferSource },
    aes,
    parts.ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

describe("protocol secrets", () => {
  test("encrypts in the browser so only the private key reads it", async () => {
    const { privateKey, publicKey } = await keyPair();
    const ciphertext = await encryptToCiphertext(publicKey, "sk_live_123");
    expect(ciphertext).not.toContain("sk_live_123");
    expect(decodeBase64Url(ciphertext.split(".")[1]!)).not.toBeNull();
    expect(await decrypt(privateKey, ciphertext)).toBe("sk_live_123");
    expect(protocolSecretState({ __resolveType: "secret", ciphertext })).toBe(
      "encrypted",
    );
  });

  test("reports what a field holds", () => {
    expect(protocolSecretState(undefined)).toBe("none");
    expect(protocolSecretState("")).toBe("none");
    // A plain string in a Secret field is exactly what must never be saved.
    expect(protocolSecretState("sk_live_123")).toBe("plaintext");
    expect(
      protocolSecretState({ __resolveType: "secret", ciphertext: "nope" }),
    ).toBe("plaintext");
  });
});
