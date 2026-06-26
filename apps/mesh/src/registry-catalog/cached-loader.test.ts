import { describe, expect, it } from "bun:test";
import { createCachedLoader } from "./cached-loader";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createCachedLoader", () => {
  it("loads once on cold start and serves the cached value while fresh", async () => {
    let calls = 0;
    const loader = createCachedLoader({
      load: async () => {
        calls++;
        return "v1";
      },
      ttlMs: 100,
      now: () => 1000,
      maxAttempts: 1,
    });

    expect(await loader.get()).toBe("v1");
    expect(await loader.get()).toBe("v1");
    expect(calls).toBe(1);
  });

  it("collapses concurrent cold loads into a single in-flight call", async () => {
    let calls = 0;
    let resolve!: (v: string) => void;
    const loader = createCachedLoader({
      load: () =>
        new Promise<string>((res) => {
          calls++;
          resolve = res;
        }),
      ttlMs: 1000,
      now: () => 0,
      maxAttempts: 1,
    });

    const p1 = loader.get();
    const p2 = loader.get();
    resolve("v1");

    expect(await p1).toBe("v1");
    expect(await p2).toBe("v1");
    expect(calls).toBe(1);
  });

  it("serves stale then refreshes in the background past the TTL", async () => {
    let calls = 0;
    let value = "v1";
    let nowMs = 1000;
    const loader = createCachedLoader({
      load: async () => {
        calls++;
        return value;
      },
      ttlMs: 100,
      now: () => nowMs,
      maxAttempts: 1,
    });

    expect(await loader.get()).toBe("v1");
    expect(calls).toBe(1);

    value = "v2";
    nowMs = 1101; // stale
    expect(await loader.get()).toBe("v1"); // stale served immediately
    await flush(); // let the background refresh settle
    expect(calls).toBe(2);
    expect(await loader.get()).toBe("v2"); // refreshed, now fresh
    expect(calls).toBe(2);
  });

  it("keeps serving the last-good value when a background refresh fails", async () => {
    let nowMs = 0;
    let shouldFail = false;
    const loader = createCachedLoader({
      load: async () => {
        if (shouldFail) throw new Error("boom");
        return "v1";
      },
      ttlMs: 100,
      now: () => nowMs,
      maxAttempts: 1,
    });

    expect(await loader.get()).toBe("v1");

    shouldFail = true;
    nowMs = 200; // stale
    expect(await loader.get()).toBe("v1"); // does not throw, serves stale
    await flush();
    expect(await loader.get()).toBe("v1");
  });

  it("rejects when the cold load fails", async () => {
    const loader = createCachedLoader({
      load: async () => {
        throw new Error("boom");
      },
      ttlMs: 1000,
      now: () => 0,
      maxAttempts: 1,
    });

    await expect(loader.get()).rejects.toThrow();
  });

  it("warm() is fail-soft and never throws", async () => {
    const loader = createCachedLoader({
      load: async () => {
        throw new Error("boom");
      },
      ttlMs: 1000,
      now: () => 0,
      maxAttempts: 1,
    });

    await loader.warm(); // should resolve despite the failing load
  });
});
