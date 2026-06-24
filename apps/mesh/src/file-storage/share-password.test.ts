import { describe, expect, it } from "bun:test";
import {
  generateShareSecret,
  hashSharePassword,
  signUnlockToken,
  unlockCookieName,
  verifySharePassword,
  verifyUnlockToken,
} from "./share-password";

describe("share-password", () => {
  it("hashes and verifies a password", async () => {
    const h = await hashSharePassword("hunter2");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifySharePassword("hunter2", h)).toBe(true);
    expect(await verifySharePassword("wrong", h)).toBe(false);
  });

  it("salts — same password yields distinct hashes", async () => {
    expect(await hashSharePassword("x")).not.toBe(await hashSharePassword("x"));
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifySharePassword("x", "garbage")).toBe(false);
    expect(await verifySharePassword("x", "scrypt$zz$zz")).toBe(false);
  });

  it("share secrets are random", () => {
    expect(generateShareSecret()).not.toBe(generateShareSecret());
  });

  it("signs and verifies an unlock token", () => {
    const t = signUnlockToken({
      o: "org",
      v: "home",
      p: "deck",
      s: "sec1",
      e: 1100,
    });
    expect(
      verifyUnlockToken(t, {
        org: "org",
        volume: "home",
        secret: "sec1",
        nowSec: 1000,
      }),
    ).toEqual({ govPath: "deck" });
  });

  it("rejects a rotated secret, expiry, org/volume mismatch, and tampering", () => {
    const t = signUnlockToken({
      o: "org",
      v: "home",
      p: "deck",
      s: "old",
      e: 2000,
    });
    const base = { org: "org", volume: "home", secret: "old", nowSec: 1000 };
    // rotated secret
    expect(verifyUnlockToken(t, { ...base, secret: "new" })).toBeNull();
    // expired
    expect(verifyUnlockToken(t, { ...base, nowSec: 3000 })).toBeNull();
    // org / volume mismatch
    expect(verifyUnlockToken(t, { ...base, org: "other" })).toBeNull();
    expect(verifyUnlockToken(t, { ...base, volume: "uploads" })).toBeNull();
    // tampered mac / malformed
    expect(verifyUnlockToken(`${t}x`, base)).toBeNull();
    expect(verifyUnlockToken("nodot", base)).toBeNull();
  });

  it("cookie name is stable, namespaced, and node-specific", () => {
    const n = unlockCookieName("org", "home", "deck");
    expect(n).toBe(unlockCookieName("org", "home", "deck"));
    expect(n.startsWith("fsu_")).toBe(true);
    expect(n).not.toBe(unlockCookieName("org", "home", "other"));
  });
});
