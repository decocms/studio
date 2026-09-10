import { beforeEach, describe, expect, it } from "bun:test";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import {
  aggregateCacheKey,
  clearAggregateCache,
  getCachedAggregate,
  invalidateAggregates,
  setCachedAggregate,
} from "./aggregate-cache";

const result = (name: string): ListToolsResult => ({
  tools: [{ name, inputSchema: { type: "object" } }],
});

const key = (over: Partial<Parameters<typeof aggregateCacheKey>[0]> = {}) =>
  aggregateCacheKey({
    virtualMcpId: "vir_a",
    userId: "user_1",
    superUser: false,
    connectionIds: ["conn_a", "conn_b"],
    ...over,
  });

beforeEach(() => {
  clearAggregateCache();
});

describe("aggregateCacheKey", () => {
  it("is stable regardless of connection order", () => {
    expect(key({ connectionIds: ["conn_b", "conn_a"] })).toBe(
      key({ connectionIds: ["conn_a", "conn_b"] }),
    );
  });

  it("separates users — a child's tools can differ per user token", () => {
    expect(key({ userId: "user_2" })).not.toBe(key());
  });

  it("separates the superuser bypass from a normal caller", () => {
    expect(key({ superUser: true })).not.toBe(key());
  });

  it("separates a grafted dev-sandbox connection from the plain agent", () => {
    expect(key({ connectionIds: ["conn_a", "conn_b", "dev_x"] })).not.toBe(
      key(),
    );
  });

  it("separates two agents sharing the same children", () => {
    expect(key({ virtualMcpId: "vir_b" })).not.toBe(key());
  });

  it("distinguishes an anonymous caller from a named one", () => {
    expect(key({ userId: null })).not.toBe(key({ userId: "anon" }));
  });
});

describe("get/set", () => {
  it("returns nothing for an unknown key", () => {
    expect(getCachedAggregate(key())).toBeNull();
  });

  it("serves the same promise back, collapsing a concurrent burst", async () => {
    let calls = 0;
    const aggregate = () => {
      calls++;
      return Promise.resolve(result("t"));
    };

    const k = key();
    const first =
      getCachedAggregate(k) ?? setCachedAggregate(k, ["conn_a"], aggregate());
    const second =
      getCachedAggregate(k) ?? setCachedAggregate(k, ["conn_a"], aggregate());

    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
  });

  it("does not cache a failed aggregation", async () => {
    const k = key();
    const failing = setCachedAggregate(
      k,
      ["conn_a"],
      Promise.reject(new Error("upstream down")),
    );

    await expect(failing).rejects.toThrow("upstream down");
    expect(getCachedAggregate(k)).toBeNull();
  });

  it("keeps a later successful write after an earlier failure settles", async () => {
    const k = key();
    const failing = setCachedAggregate(
      k,
      ["conn_a"],
      Promise.reject(new Error("transient")),
    );
    const good = setCachedAggregate(
      k,
      ["conn_a"],
      Promise.resolve(result("good")),
    );

    await expect(failing).rejects.toThrow("transient");
    await good;

    // The rejection must evict only its OWN entry, never the one that replaced
    // it — otherwise a slow failure silently wipes a fresh good aggregate.
    expect(getCachedAggregate(k)).not.toBeNull();
    expect(await getCachedAggregate(k)!).toEqual(result("good"));
  });
});

describe("invalidateAggregates", () => {
  it("drops entries built from the named child connection", async () => {
    const k = key();
    await setCachedAggregate(
      k,
      ["conn_a", "conn_b"],
      Promise.resolve(result("t")),
    );

    invalidateAggregates("conn_b");

    expect(getCachedAggregate(k)).toBeNull();
  });

  it("drops entries whose agent connection itself changed", async () => {
    const k = key();
    await setCachedAggregate(
      k,
      ["conn_a", "vir_a"],
      Promise.resolve(result("t")),
    );

    invalidateAggregates("vir_a");

    expect(getCachedAggregate(k)).toBeNull();
  });

  it("leaves unrelated entries alone", async () => {
    const mine = key();
    const theirs = key({ userId: "user_2", connectionIds: ["conn_z"] });
    await setCachedAggregate(mine, ["conn_a"], Promise.resolve(result("a")));
    await setCachedAggregate(theirs, ["conn_z"], Promise.resolve(result("z")));

    invalidateAggregates("conn_a");

    expect(getCachedAggregate(mine)).toBeNull();
    expect(getCachedAggregate(theirs)).not.toBeNull();
  });
});

describe("bounds", () => {
  it("evicts the oldest entry past the cap", async () => {
    const first = key({ virtualMcpId: "vir_0" });
    await setCachedAggregate(first, ["c"], Promise.resolve(result("t")));

    for (let i = 1; i <= 500; i++) {
      await setCachedAggregate(
        key({ virtualMcpId: `vir_${i}` }),
        ["c"],
        Promise.resolve(result("t")),
      );
    }

    expect(getCachedAggregate(first)).toBeNull();
    expect(getCachedAggregate(key({ virtualMcpId: "vir_500" }))).not.toBeNull();
  });

  it("re-writing a key refreshes its eviction position", async () => {
    const kept = key({ virtualMcpId: "vir_0" });
    await setCachedAggregate(kept, ["c"], Promise.resolve(result("t")));

    for (let i = 1; i < 500; i++) {
      await setCachedAggregate(
        key({ virtualMcpId: `vir_${i}` }),
        ["c"],
        Promise.resolve(result("t")),
      );
    }
    // Touch the oldest, then push one more in: the touched entry must survive.
    await setCachedAggregate(kept, ["c"], Promise.resolve(result("t")));
    await setCachedAggregate(
      key({ virtualMcpId: "vir_500" }),
      ["c"],
      Promise.resolve(result("t")),
    );

    expect(getCachedAggregate(kept)).not.toBeNull();
  });
});
