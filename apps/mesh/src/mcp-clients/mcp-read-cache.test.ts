import { describe, expect, it } from "bun:test";
import { InMemoryMcpReadCache } from "./mcp-read-cache";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("InMemoryMcpReadCache", () => {
  it("returns null on miss and the value after set", () => {
    const cache = new InMemoryMcpReadCache();
    const params = { uri: "file://a" };
    expect(cache.get("resources/read", "c1", params)).toBeNull();
    cache.set("resources/read", "c1", params, { contents: [1] });
    expect(cache.get("resources/read", "c1", params)).toEqual({
      contents: [1],
    });
  });

  it("hashes params order-independently", () => {
    const cache = new InMemoryMcpReadCache();
    cache.set(
      "prompts/get",
      "c1",
      { name: "p", arguments: { a: 1, b: 2 } },
      {
        v: 1,
      },
    );
    // Same params, keys in different order — must hit the same entry.
    expect(
      cache.get("prompts/get", "c1", { arguments: { b: 2, a: 1 }, name: "p" }),
    ).toEqual({ v: 1 });
  });

  it("isolates by connection, type, and params", () => {
    const cache = new InMemoryMcpReadCache();
    const params = { uri: "file://a" };
    cache.set("resources/read", "c1", params, { v: "c1" });
    expect(cache.get("resources/read", "c2", params)).toBeNull();
    expect(cache.get("prompts/get", "c1", params)).toBeNull();
    expect(cache.get("resources/read", "c1", { uri: "file://b" })).toBeNull();
  });

  it("expires entries after the TTL", async () => {
    const cache = new InMemoryMcpReadCache(5 /* ttlMs */);
    const params = { uri: "file://a" };
    cache.set("resources/read", "c1", params, { v: 1 });
    expect(cache.get("resources/read", "c1", params)).toEqual({ v: 1 });
    await sleep(15);
    expect(cache.get("resources/read", "c1", params)).toBeNull();
  });

  it("evicts the least-recently-used entry past capacity", () => {
    const cache = new InMemoryMcpReadCache(60_000, 2 /* maxEntries */);
    cache.set("resources/read", "c", { uri: "a" }, { v: "a" });
    cache.set("resources/read", "c", { uri: "b" }, { v: "b" });
    // Touch "a" so "b" becomes the LRU eviction candidate.
    cache.get("resources/read", "c", { uri: "a" });
    cache.set("resources/read", "c", { uri: "d" }, { v: "d" });

    expect(cache.get("resources/read", "c", { uri: "a" })).toEqual({ v: "a" });
    expect(cache.get("resources/read", "c", { uri: "b" })).toBeNull();
    expect(cache.get("resources/read", "c", { uri: "d" })).toEqual({ v: "d" });
  });

  it("invalidate drops only the target connection's entries", () => {
    const cache = new InMemoryMcpReadCache();
    cache.set("resources/read", "c1", { uri: "a" }, { v: 1 });
    cache.set("prompts/get", "c1", { name: "p" }, { v: 2 });
    cache.set("resources/read", "c2", { uri: "a" }, { v: 3 });

    cache.invalidate("c1");

    expect(cache.get("resources/read", "c1", { uri: "a" })).toBeNull();
    expect(cache.get("prompts/get", "c1", { name: "p" })).toBeNull();
    expect(cache.get("resources/read", "c2", { uri: "a" })).toEqual({ v: 3 });
  });

  it("does not cache oversized results", () => {
    const cache = new InMemoryMcpReadCache();
    const params = { uri: "file://big" };
    const big = { blob: "x".repeat(3 * 1024 * 1024) }; // > 2 MiB cap
    cache.set("resources/read", "c1", params, big);
    expect(cache.get("resources/read", "c1", params)).toBeNull();
  });
});
