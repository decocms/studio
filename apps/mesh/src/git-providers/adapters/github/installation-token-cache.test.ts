import { describe, expect, test } from "bun:test";
import { InstallationTokenCache } from "./installation-token-cache";

describe("InstallationTokenCache", () => {
  test("caches a token until it nears expiry", async () => {
    const cache = new InstallationTokenCache();
    let mintCalls = 0;
    const mint = async () => {
      mintCalls++;
      return {
        token: `tok-${mintCalls}`,
        expiresAtMs: Date.now() + 60 * 60 * 1000, // 1h
      };
    };

    const a = await cache.get("inst-1", mint);
    const b = await cache.get("inst-1", mint);
    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    expect(mintCalls).toBe(1);
  });

  test("refreshes when within the 5-minute buffer of expiry", async () => {
    const cache = new InstallationTokenCache();
    let mintCalls = 0;
    const mint = async () => {
      mintCalls++;
      return {
        token: `tok-${mintCalls}`,
        // Expires in 2 minutes — inside the 5min refresh buffer
        expiresAtMs: Date.now() + 2 * 60 * 1000,
      };
    };

    await cache.get("inst-1", mint);
    const second = await cache.get("inst-1", mint);
    expect(mintCalls).toBe(2);
    expect(second).toBe("tok-2");
  });

  test("de-duplicates concurrent refreshes", async () => {
    const cache = new InstallationTokenCache();
    let mintCalls = 0;
    const mint = async () => {
      mintCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        token: `tok-${mintCalls}`,
        expiresAtMs: Date.now() + 60 * 60 * 1000,
      };
    };

    const [a, b, c] = await Promise.all([
      cache.get("inst-1", mint),
      cache.get("inst-1", mint),
      cache.get("inst-1", mint),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(mintCalls).toBe(1);
  });

  test("invalidate forces a re-mint on next call", async () => {
    const cache = new InstallationTokenCache();
    let mintCalls = 0;
    const mint = async () => {
      mintCalls++;
      return {
        token: `tok-${mintCalls}`,
        expiresAtMs: Date.now() + 60 * 60 * 1000,
      };
    };

    await cache.get("inst-1", mint);
    cache.invalidate("inst-1");
    await cache.get("inst-1", mint);
    expect(mintCalls).toBe(2);
  });
});
