/**
 * Read cache: SWR semantics, single-flight revalidation, scope + type + param
 * keying, staleness bounds, the no-cache guard, oversized rejection, and
 * per-type config. Pure in-memory logic with an injected clock — no DB, no
 * network.
 */
import { describe, expect, test } from "bun:test";
import {
  InMemoryMcpReadCache,
  type McpReadType,
  type ReadCacheScope,
} from "./mcp-read-cache";

const ORG: ReadCacheScope = { kind: "org" };
const CONN = "conn_a";
const TOOL: McpReadType = "tools/call";

function configFor(
  revalidateAfterMs: number,
  maxStaleMs: number,
  maxValueBytes: number,
): Record<
  McpReadType,
  {
    revalidateAfterMs: number;
    maxStaleMs: number;
    maxValueBytes: number;
  }
> {
  const c = { revalidateAfterMs, maxStaleMs, maxValueBytes };
  return { "tools/call": c, "resources/read": c, "prompts/get": c };
}

function newCache(opts?: {
  revalidateAfterMs?: number;
  maxStaleMs?: number;
  maxValueBytes?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
}) {
  let now = 1_000;
  const cache = new InMemoryMcpReadCache(
    configFor(
      opts?.revalidateAfterMs ?? 30_000,
      opts?.maxStaleMs ?? 300_000,
      opts?.maxValueBytes ?? 2 * 1024 * 1024,
    ),
    opts?.maxEntries ?? 2000,
    () => now,
    opts?.maxTotalBytes ?? 256 * 1024 * 1024,
  );
  return { cache, advance: (ms: number) => (now += ms) };
}

describe("InMemoryMcpReadCache", () => {
  test("miss fetches live, stores, and returns; hit reuses it", async () => {
    const { cache } = newCache();
    let calls = 0;
    const fetchLive = async () => ({ value: `v${++calls}` });

    const r1 = await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: { a: 1 },
      fetchLive,
    });
    const r2 = await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: { a: 1 },
      fetchLive,
    });

    expect(r1).toEqual({ value: "v1" });
    expect(r2).toEqual({ value: "v1" });
    expect(calls).toBe(1);
  });

  test("param equality is order-independent", async () => {
    const { cache } = newCache();
    let calls = 0;
    const fetchLive = async () => ({ calls: ++calls });
    await cache.fetch({
      type: "prompts/get",
      connectionId: CONN,
      scope: ORG,
      params: { name: "p", arguments: { a: 1, b: 2 } },
      fetchLive,
    });
    const r = await cache.fetch({
      type: "prompts/get",
      connectionId: CONN,
      scope: ORG,
      params: { arguments: { b: 2, a: 1 }, name: "p" },
      fetchLive,
    });
    expect(r).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  });

  test("isolates by connection, type, scope, and params", async () => {
    const { cache } = newCache();
    const live = (tag: string) => async () => ({ tag });
    const base = {
      connectionId: CONN,
      scope: ORG,
      params: { uri: "file://a" },
    } as const;

    await cache.fetch({
      ...base,
      type: "resources/read",
      fetchLive: live("a"),
    });
    // Different connection / type / scope / params all miss (distinct keys).
    expect(
      await cache.fetch({
        ...base,
        connectionId: "conn_b",
        type: "resources/read",
        fetchLive: live("conn_b"),
      }),
    ).toEqual({ tag: "conn_b" });
    expect(
      await cache.fetch({
        ...base,
        type: "prompts/get",
        fetchLive: live("pg"),
      }),
    ).toEqual({ tag: "pg" });
    expect(
      await cache.fetch({
        ...base,
        scope: { kind: "user", userId: "u1" },
        type: "resources/read",
        fetchLive: live("user"),
      }),
    ).toEqual({ tag: "user" });
    expect(
      await cache.fetch({
        ...base,
        type: "resources/read",
        params: { uri: "file://b" },
        fetchLive: live("b"),
      }),
    ).toEqual({ tag: "b" });
    // Original still cached.
    expect(
      await cache.fetch({
        ...base,
        type: "resources/read",
        fetchLive: live("SHOULD_NOT_RUN"),
      }),
    ).toEqual({ tag: "a" });
  });

  test("stale hit serves immediately and revalidates once in the background", async () => {
    const { cache, advance } = newCache({ revalidateAfterMs: 30_000 });
    let calls = 0;
    const fetchLive = async () => ({ value: `v${++calls}` });

    const first = await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive,
    });
    expect(first).toEqual({ value: "v1" });

    advance(31_000);

    let bg: Promise<void> | undefined;
    const stale = await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive,
      onRevalidation: (p) => {
        bg = p;
      },
    });
    expect(stale).toEqual({ value: "v1" }); // served stale synchronously
    expect(bg).toBeDefined();
    await bg;
    expect(calls).toBe(2); // refreshed in background

    const fresh = await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive,
    });
    expect(fresh).toEqual({ value: "v2" });
  });

  test("single-flight: concurrent stale hits trigger one revalidation", async () => {
    const { cache, advance } = newCache({ revalidateAfterMs: 10_000 });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchLive = async () => {
      calls++;
      if (calls > 1) await gate;
      return { calls };
    };

    await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive,
    });
    advance(11_000);

    const bgs: Promise<void>[] = [];
    const reads = await Promise.all(
      Array.from({ length: 8 }, () =>
        cache.fetch({
          type: TOOL,
          connectionId: CONN,
          scope: ORG,
          params: {},
          fetchLive,
          onRevalidation: (p) => bgs.push(p),
        }),
      ),
    );
    for (const r of reads) expect(r).toEqual({ calls: 1 });
    expect(bgs.length).toBe(1);
    release();
    await Promise.all(bgs);
    expect(calls).toBe(2);
  });

  test("past maxStale, a hit becomes a blocking miss", async () => {
    const { cache, advance } = newCache({
      revalidateAfterMs: 10_000,
      maxStaleMs: 60_000,
    });
    let calls = 0;
    const fetchLive = async () => ({ value: `v${++calls}` });
    await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive,
    });
    advance(61_000);
    const r = await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive,
    });
    expect(r).toEqual({ value: "v2" });
    expect(calls).toBe(2);
  });

  test("shouldCache=false returns the value but does not store it", async () => {
    const { cache } = newCache();
    let calls = 0;
    const fetchLive = async () => ({ isError: true, calls: ++calls });
    const shouldCache = (v: unknown) =>
      (v as { isError?: boolean }).isError !== true;

    const r1 = await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive,
      shouldCache,
    });
    const r2 = await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive,
      shouldCache,
    });
    expect(r1).toEqual({ isError: true, calls: 1 });
    expect(r2).toEqual({ isError: true, calls: 2 }); // not cached
    expect(calls).toBe(2);
  });

  test("does not cache oversized results", async () => {
    const { cache } = newCache({ maxValueBytes: 64 });
    let calls = 0;
    const fetchLive = async () => ({ blob: "x".repeat(1000), calls: ++calls });
    await cache.fetch({
      type: "resources/read",
      connectionId: CONN,
      scope: ORG,
      params: { uri: "big" },
      fetchLive,
    });
    const r = await cache.fetch({
      type: "resources/read",
      connectionId: CONN,
      scope: ORG,
      params: { uri: "big" },
      fetchLive,
    });
    expect(calls).toBe(2); // never stored → refetched
    expect((r as { calls: number }).calls).toBe(2);
  });

  test("evicts the least-recently-used entry past capacity", async () => {
    const { cache } = newCache({ maxEntries: 2 });
    // Count live fetches per key; a hit (bump) does not fetch, an evicted key
    // refetches. Asserting on counts avoids perturbing LRU order with reads.
    const counts: Record<string, number> = {};
    const read = (uri: string) =>
      cache.fetch({
        type: "resources/read",
        connectionId: CONN,
        scope: ORG,
        params: { uri },
        fetchLive: async () => {
          counts[uri] = (counts[uri] ?? 0) + 1;
          return { uri };
        },
      });

    await read("a"); // miss → {a}
    await read("b"); // miss → {a,b}
    await read("a"); // HIT (bump a) → {b,a}; no fetch
    await read("c"); // miss → evicts LRU "b" → {a,c}
    await read("b"); // miss again (was evicted) → refetch

    // "a" fetched once (the second read was a hit), "b" twice (evicted by "c").
    expect(counts).toEqual({ a: 1, b: 2, c: 1 });
  });

  test("evicts by total-byte budget even under the entry-count cap", async () => {
    // ~102-byte values; budget of 250 holds two, so the third evicts the LRU
    // even though the entry-count cap (1000) is nowhere near hit.
    const { cache } = newCache({ maxEntries: 1000, maxTotalBytes: 250 });
    const counts: Record<string, number> = {};
    const read = (uri: string) =>
      cache.fetch({
        type: "resources/read",
        connectionId: CONN,
        scope: ORG,
        params: { uri },
        fetchLive: async () => {
          counts[uri] = (counts[uri] ?? 0) + 1;
          return "x".repeat(100);
        },
      });

    await read("a"); // {a}
    await read("b"); // {a,b} ~204b
    await read("c"); // 306b > 250 → evict LRU "a" → {b,c}
    await read("a"); // evicted by bytes → refetch

    expect(counts).toEqual({ a: 2, b: 1, c: 1 });
  });

  test("invalidate drops only the target connection's entries", async () => {
    const { cache } = newCache();
    let calls = 0;
    const fetchLive = async () => ({ calls: ++calls });
    await cache.fetch({
      type: "resources/read",
      connectionId: CONN,
      scope: ORG,
      params: { uri: "a" },
      fetchLive,
    });
    await cache.fetch({
      type: "resources/read",
      connectionId: "conn_b",
      scope: ORG,
      params: { uri: "a" },
      fetchLive,
    });

    cache.invalidate(CONN);

    // conn_a refetches, conn_b still cached.
    expect(
      await cache.fetch({
        type: "resources/read",
        connectionId: CONN,
        scope: ORG,
        params: { uri: "a" },
        fetchLive,
      }),
    ).toEqual({ calls: 3 });
    expect(
      await cache.fetch({
        type: "resources/read",
        connectionId: "conn_b",
        scope: ORG,
        params: { uri: "a" },
        fetchLive,
      }),
    ).toEqual({ calls: 2 });
  });

  test("config is per-type: one type can be stale while another is fresh", async () => {
    let now = 1_000;
    const cache = new InMemoryMcpReadCache(
      {
        "tools/call": {
          revalidateAfterMs: 10_000,
          maxStaleMs: 300_000,
          maxValueBytes: 1024,
        },
        "resources/read": {
          revalidateAfterMs: 100_000,
          maxStaleMs: 300_000,
          maxValueBytes: 1024,
        },
        "prompts/get": {
          revalidateAfterMs: 100_000,
          maxStaleMs: 300_000,
          maxValueBytes: 1024,
        },
      },
      2000,
      () => now,
    );
    const live = async () => ({ ok: true });
    await cache.fetch({
      type: "tools/call",
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive: live,
    });
    await cache.fetch({
      type: "resources/read",
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive: live,
    });

    now += 50_000; // past tools/call revalidate (10s), before resources/read (100s)

    let toolBg = false;
    await cache.fetch({
      type: "tools/call",
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive: live,
      onRevalidation: () => {
        toolBg = true;
      },
    });
    let resBg = false;
    await cache.fetch({
      type: "resources/read",
      connectionId: CONN,
      scope: ORG,
      params: {},
      fetchLive: live,
      onRevalidation: () => {
        resBg = true;
      },
    });

    expect(toolBg).toBe(true); // stale → revalidated
    expect(resBg).toBe(false); // still fresh → not revalidated
  });

  test("stats() tracks entry count and bytes, decremented on eviction", async () => {
    // maxEntries=1 forces an eviction so bytes can't only ever grow.
    const { cache } = newCache({ maxEntries: 1 });
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });

    await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: { a: 1 },
      fetchLive: async () => ({ value: "first" }),
    });
    const afterFirst = cache.stats();
    expect(afterFirst.entries).toBe(1);
    expect(afterFirst.bytes).toBeGreaterThan(0);

    // Second distinct key evicts the first (LRU) — entries stays at 1, bytes
    // reflect only the surviving entry (proves the running sum is decremented).
    await cache.fetch({
      type: TOOL,
      connectionId: CONN,
      scope: ORG,
      params: { b: 22222 },
      fetchLive: async () => ({ value: "second" }),
    });
    const afterSecond = cache.stats();
    expect(afterSecond.entries).toBe(1);
    expect(afterSecond.bytes).toBe(JSON.stringify({ value: "second" }).length);
  });
});

/**
 * A revalidation runs on whatever connection the caller's `fetchLive` closes
 * over, and it starts AFTER the stale value is returned. So a caller that tears
 * that connection down as soon as `fetch` resolves kills every refresh it ever
 * triggers, and the entry then sits unchanged until `maxStaleMs` — which is how
 * a task-board PR card got stuck showing no deploy preview and no checks for
 * half an hour. `onRevalidation` is the contract that prevents it: hold the
 * connection open until the promises it hands out settle.
 */
describe("onRevalidation guards the caller's connection lifetime", () => {
  const staleThenRefresh = async (holdOpen: boolean) => {
    const { cache, advance } = newCache({
      revalidateAfterMs: 10_000,
      maxStaleMs: 60_000,
    });
    let closed = false;
    let version = 1;
    // A real call is in flight for a while; closing the transport under it is
    // what fails it, so the check belongs at resolution time, not at entry.
    const fetchLive = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (closed) throw new Error("connection closed");
      return { version };
    };
    const read = async () => {
      const pending: Promise<void>[] = [];
      const value = await cache.fetch({
        type: TOOL,
        connectionId: CONN,
        scope: ORG,
        params: {},
        fetchLive,
        onRevalidation: (p) => pending.push(p),
      });
      // The eager close is the bug; awaiting `pending` first is the fix.
      if (holdOpen) await Promise.allSettled(pending);
      closed = true;
      return value;
    };

    expect(await read()).toEqual({ version: 1 });
    version = 2;
    closed = false;
    advance(11_000);
    // Stale: serves the old value either way, and kicks off the refresh.
    expect(await read()).toEqual({ version: 1 });
    closed = false;
    advance(1_000);
    return read();
  };

  test("closing eagerly loses the refresh — the entry stays stale", async () => {
    expect(await staleThenRefresh(false)).toEqual({ version: 1 });
  });

  test("holding open until it settles refreshes the entry", async () => {
    expect(await staleThenRefresh(true)).toEqual({ version: 2 });
  });
});
