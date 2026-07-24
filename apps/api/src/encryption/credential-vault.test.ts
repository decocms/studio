import { describe, expect, it } from "bun:test";
import { CredentialVault } from "./credential-vault";

describe("CredentialVault", () => {
  const testKey = CredentialVault.generateKey();
  const vault = new CredentialVault(testKey);

  describe("encrypt", () => {
    it("should encrypt plaintext", async () => {
      const plaintext = "my-secret-token";
      const encrypted = await vault.encrypt(plaintext);

      expect(encrypted).toBeDefined();
      expect(encrypted).not.toBe(plaintext);
      expect(typeof encrypted).toBe("string");
    });

    it("should produce different ciphertext each time", async () => {
      const plaintext = "same-secret";
      const encrypted1 = await vault.encrypt(plaintext);
      const encrypted2 = await vault.encrypt(plaintext);

      // Different because of random IV
      expect(encrypted1).not.toBe(encrypted2);
    });

    it("should return base64 string", async () => {
      const encrypted = await vault.encrypt("test");

      // Should be valid base64
      expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
    });

    it("should handle empty string", async () => {
      const encrypted = await vault.encrypt("");
      const decrypted = await vault.decrypt(encrypted);

      expect(decrypted).toBe("");
    });
  });

  describe("decrypt", () => {
    it("should decrypt ciphertext back to plaintext", async () => {
      const plaintext = "my-secret-token";
      const encrypted = await vault.encrypt(plaintext);
      const decrypted = await vault.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should handle special characters", async () => {
      const plaintext = "token!@#$%^&*(){}[]<>?/:;'\"|\\+=~`";
      const encrypted = await vault.encrypt(plaintext);
      const decrypted = await vault.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should handle unicode characters", async () => {
      const plaintext = "Hello 世界 🌍";
      const encrypted = await vault.encrypt(plaintext);
      const decrypted = await vault.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should handle long strings", async () => {
      const plaintext = "a".repeat(10000);
      const encrypted = await vault.encrypt(plaintext);
      const decrypted = await vault.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should throw on invalid ciphertext", async () => {
      await expect(vault.decrypt("invalid-base64!!!")).rejects.toThrow();
    });

    it("should throw on tampered ciphertext", async () => {
      const plaintext = "secret";
      const encrypted = await vault.encrypt(plaintext);

      // Tamper with the ciphertext
      const buffer = Buffer.from(encrypted, "base64");
      buffer[buffer.length - 1] = (buffer[buffer.length - 1] ?? 0) ^ 0xff;
      const tampered = buffer.toString("base64");

      await expect(vault.decrypt(tampered)).rejects.toThrow();
    });

    it("should throw on truncated ciphertext", async () => {
      const plaintext = "secret";
      const encrypted = await vault.encrypt(plaintext);

      // Truncate the ciphertext
      const truncated = encrypted.substring(0, encrypted.length - 10);

      await expect(vault.decrypt(truncated)).rejects.toThrow();
    });
  });

  describe("different vaults", () => {
    it("should not decrypt with different key", async () => {
      const vault1 = new CredentialVault(CredentialVault.generateKey());
      const vault2 = new CredentialVault(CredentialVault.generateKey());

      const plaintext = "secret";
      const encrypted = await vault1.encrypt(plaintext);

      // Different key = decryption fails
      await expect(vault2.decrypt(encrypted)).rejects.toThrow();
    });

    it("should decrypt with same key", async () => {
      const sharedKey = CredentialVault.generateKey();
      const vault1 = new CredentialVault(sharedKey);
      const vault2 = new CredentialVault(sharedKey);

      const plaintext = "secret";
      const encrypted = await vault1.encrypt(plaintext);
      const decrypted = await vault2.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe("generateKey", () => {
    it("should generate base64 key", () => {
      const key = CredentialVault.generateKey();

      expect(typeof key).toBe("string");
      expect(() => Buffer.from(key, "base64")).not.toThrow();
    });

    it("should generate 32-byte key", () => {
      const key = CredentialVault.generateKey();
      const buffer = Buffer.from(key, "base64");

      expect(buffer.length).toBe(32);
    });

    it("should generate different keys", () => {
      const key1 = CredentialVault.generateKey();
      const key2 = CredentialVault.generateKey();

      expect(key1).not.toBe(key2);
    });

    it("should generate cryptographically secure keys", () => {
      const keys = new Set();
      for (let i = 0; i < 100; i++) {
        keys.add(CredentialVault.generateKey());
      }

      // All keys should be unique
      expect(keys.size).toBe(100);
    });
  });

  describe("key handling", () => {
    it("should accept base64-encoded 32-byte key", () => {
      const key = CredentialVault.generateKey();
      const vault = new CredentialVault(key);

      expect(vault).toBeDefined();
    });

    it("should hash non-base64 keys to 32 bytes", async () => {
      const vault = new CredentialVault("simple-string-key");

      const plaintext = "test";
      const encrypted = await vault.encrypt(plaintext);
      const decrypted = await vault.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should produce consistent encryption with same key", async () => {
      const key = "test-key";
      const vault1 = new CredentialVault(key);
      const vault2 = new CredentialVault(key);

      const plaintext = "secret";
      const encrypted1 = await vault1.encrypt(plaintext);
      const decrypted2 = await vault2.decrypt(encrypted1);

      expect(decrypted2).toBe(plaintext);
    });
  });
});
