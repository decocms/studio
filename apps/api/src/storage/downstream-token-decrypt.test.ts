import { describe, expect, it } from "bun:test";
import { CredentialVault } from "../encryption/credential-vault";
import {
  decryptDownstreamTokenRow,
  type RawDownstreamTokenRow,
} from "./downstream-token";

function row(overrides: Partial<RawDownstreamTokenRow>): RawDownstreamTokenRow {
  return {
    id: "dtok_1",
    connectionId: "conn_1",
    accessToken: "not-ciphertext",
    refreshToken: null,
    scope: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    clientId: null,
    clientSecret: null,
    tokenEndpoint: null,
    ...overrides,
  };
}

describe("decryptDownstreamTokenRow", () => {
  it("decrypts a well-formed row", async () => {
    const vault = new CredentialVault(CredentialVault.generateKey());
    const accessToken = await vault.encrypt("secret-access");
    const refreshToken = await vault.encrypt("secret-refresh");

    const result = await decryptDownstreamTokenRow(
      vault,
      row({ accessToken, refreshToken }),
    );

    expect(result?.accessToken).toBe("secret-access");
    expect(result?.refreshToken).toBe("secret-refresh");
  });

  // A tampered/undecryptable row must degrade to "no cached token", not throw.
  it("returns null instead of throwing on corrupted ciphertext", async () => {
    const vault = new CredentialVault(CredentialVault.generateKey());

    const result = await decryptDownstreamTokenRow(
      vault,
      row({ accessToken: "definitely-not-valid-aes-gcm-ciphertext" }),
    );

    expect(result).toBeNull();
  });

  it("returns null when the row was encrypted under a different vault key", async () => {
    const oldVault = new CredentialVault(CredentialVault.generateKey());
    const currentVault = new CredentialVault(CredentialVault.generateKey());
    const accessToken = await oldVault.encrypt("secret-access");

    const result = await decryptDownstreamTokenRow(
      currentVault,
      row({ accessToken }),
    );

    expect(result).toBeNull();
  });
});
