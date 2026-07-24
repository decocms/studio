import { describe, expect, it, setSystemTime } from "bun:test";
import { createTtlLruCache } from "./ttl-lru-cache";

describe("createTtlLruCache", () => {
  it("returns set values before expiry", () => {
    const cache = createTtlLruCache<number>({ ttlMs: 1000 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("returns undefined for missing keys", () => {
    const cache = createTtlLruCache<number>();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("expires entries after the TTL elapses", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cache = createTtlLruCache<number>({ ttlMs: 1000 });
    cache.set("a", 1);
    setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(cache.get("a")).toBeUndefined();
    setSystemTime();
  });

  it("evicts oldest-inserted entries when over maxSize", () => {
    const cache = createTtlLruCache<number>({ ttlMs: 60_000, maxSize: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("does not promote on get by default (insertion-order eviction)", () => {
    const cache = createTtlLruCache<number>({ ttlMs: 60_000, maxSize: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // no promotion by default
    cache.set("c", 3); // evicts oldest-inserted "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  it("updateRecencyOnGet promotes read entries and preserves TTL", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cache = createTtlLruCache<number>({
      ttlMs: 1000,
      maxSize: 2,
      updateRecencyOnGet: true,
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // a becomes most-recently-used
    cache.set("c", 3); // should evict b, not a
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    // TTL is not extended by the read: a still expires on the original schedule.
    setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(cache.get("a")).toBeUndefined();
    setSystemTime();
  });

  it("re-inserting a key refreshes its recency position", () => {
    const cache = createTtlLruCache<number>({ ttlMs: 60_000, maxSize: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10); // a is now newest
    cache.set("c", 3); // should evict b, not a
    expect(cache.get("a")).toBe(10);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("delete removes a single entry", () => {
    const cache = createTtlLruCache<number>();
    cache.set("a", 1);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
  });

  it("clear removes all entries", () => {
    const cache = createTtlLruCache<number>();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
