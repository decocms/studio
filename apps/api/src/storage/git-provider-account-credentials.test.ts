import { describe, expect, it } from "bun:test";
import { CredentialVault } from "../encryption/credential-vault";
import {
  decryptGitProviderAccountCredentialRow,
  type RawGitProviderAccountCredentialRow,
} from "./git-provider-account-credentials";

function row(
  overrides: Partial<RawGitProviderAccountCredentialRow>,
): RawGitProviderAccountCredentialRow {
  return {
    account_id: "acc_1",
    access_token: "not-ciphertext",
    refresh_token: null,
    scope: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    client_id: null,
    client_secret: null,
    token_endpoint: null,
    ...overrides,
  };
}

describe("decryptGitProviderAccountCredentialRow", () => {
  it("decrypts a well-formed row", async () => {
    const vault = new CredentialVault(CredentialVault.generateKey());
    const access_token = await vault.encrypt("secret-access");
    const refresh_token = await vault.encrypt("secret-refresh");

    const result = await decryptGitProviderAccountCredentialRow(
      vault,
      row({ access_token, refresh_token }),
    );

    expect(result?.accessToken).toBe("secret-access");
    expect(result?.refreshToken).toBe("secret-refresh");
  });

  // A tampered/undecryptable row must degrade to "no cached credential", not throw.
  it("returns null instead of throwing on corrupted ciphertext", async () => {
    const vault = new CredentialVault(CredentialVault.generateKey());

    const result = await decryptGitProviderAccountCredentialRow(
      vault,
      row({ access_token: "definitely-not-valid-aes-gcm-ciphertext" }),
    );

    expect(result).toBeNull();
  });

  it("returns null when the row was encrypted under a different vault key", async () => {
    const oldVault = new CredentialVault(CredentialVault.generateKey());
    const currentVault = new CredentialVault(CredentialVault.generateKey());
    const access_token = await oldVault.encrypt("secret-access");

    const result = await decryptGitProviderAccountCredentialRow(
      currentVault,
      row({ access_token }),
    );

    expect(result).toBeNull();
  });
});
