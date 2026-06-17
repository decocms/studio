/**
 * Credential Vault
 *
 * Encrypts and decrypts sensitive credentials using AES-256-GCM.
 * Used for:
 * - Connection tokens
 * - OAuth client secrets
 * - Downstream MCP tokens
 * - Connection configuration state (may contain secrets)
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // For AES, this is always 16
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * CredentialVault for encrypting/decrypting sensitive credentials
 * Uses AES-256-GCM for authenticated encryption
 */
export class CredentialVault {
  private key: Buffer;

  constructor(encryptionKey: string) {
    // Ensure key is exactly 32 bytes
    if (Buffer.from(encryptionKey, "base64").length === KEY_LENGTH) {
      this.key = Buffer.from(encryptionKey, "base64");
    } else {
      // Hash the key to get 32 bytes
      this.key = createHash("sha256").update(encryptionKey).digest();
    }
  }

  /**
   * Encrypt a credential
   * Returns base64-encoded string containing IV + authTag + encrypted data
   */
  async encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);

    let encrypted = cipher.update(plaintext, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    const authTag = cipher.getAuthTag();

    // Combine: IV + authTag + encrypted data
    const combined = Buffer.concat([iv, authTag, encrypted]);

    return combined.toString("base64");
  }

  /**
   * Decrypt a credential
   * Expects base64-encoded string containing IV + authTag + encrypted data
   */
  async decrypt(ciphertext: string): Promise<string> {
    const combined = Buffer.from(ciphertext, "base64");

    // Extract components
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString("utf8");
  }

  /**
   * Generate a new random encryption key (base64-encoded 32 bytes)
   */
  static generateKey(): string {
    return randomBytes(KEY_LENGTH).toString("base64");
  }
}
