import { describe, expect, test } from "bun:test";
import type { KV } from "@nats-io/kv";
import { JetStreamKVPrCache, PR_CARDS_CACHE, PR_READS_CACHE } from "./pr-cache";

/** Minimal in-process stand-in for the KV bucket: only what the cache calls. */
function fakeKv(): KV {
  const store = new Map<string, Uint8Array>();
  return {
    get: async (key: string) => {
      const value = store.get(key);
      return value ? { value, operation: "PUT" } : null;
    },
    put: async (key: string, value: Uint8Array) => {
      store.set(key, value);
      return 1;
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    keys: async (filter: string) => {
      const prefix = filter.replace(/\.\*$/, ".");
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
  } as unknown as KV;
}

async function cacheAt(clock: { now: number }) {
  const cache = new JetStreamKVPrCache(
    PR_READS_CACHE,
    { getJetStream: () => null },
    () => clock.now,
  );
  await cache.init(fakeKv());
  return cache;
}

describe("JetStreamKVPrCache", () => {
  test("serves the stored read, then revalidates in the background once stale", async () => {
    const clock = { now: 0 };
    const cache = await cacheAt(clock);
    let calls = 0;
    const pending: Promise<void>[] = [];
    const read = () =>
      cache.fetch({
        namespace: "conn_1",
        key: JSON.stringify({ name: "pull_request_read", number: 7 }),
        fetchLive: async () => ({ n: ++calls }),
        onRevalidation: (p: Promise<void>) => pending.push(p),
      });

    expect(await read()).toEqual({ n: 1 });
    // Fresh: served from KV, no second GitHub call.
    clock.now = 10_000;
    expect(await read()).toEqual({ n: 1 });
    expect(calls).toBe(1);

    // Stale: the OLD value is returned immediately while one refresh runs.
    clock.now = 60_000;
    expect(await read()).toEqual({ n: 1 });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(calls).toBe(2);
    expect(await read()).toEqual({ n: 2 });
  });

  test("keeps serving the stored read when a revalidation fails", async () => {
    const clock = { now: 0 };
    const cache = await cacheAt(clock);
    const pending: Promise<void>[] = [];
    let fail = false;
    const read = () =>
      cache.fetch({
        namespace: "conn_1",
        key: JSON.stringify({ name: "pull_request_read", number: 7 }),
        fetchLive: async () => {
          if (fail) throw new Error("too many requests");
          return { ok: true };
        },
        onRevalidation: (p: Promise<void>) => pending.push(p),
      });

    await read();
    fail = true;
    clock.now = 60_000;
    expect(await read()).toEqual({ ok: true });
    await Promise.all(pending);
    expect(await read()).toEqual({ ok: true });
  });

  test("invalidate drops the connection's reads", async () => {
    const clock = { now: 0 };
    const cache = await cacheAt(clock);
    let calls = 0;
    const read = () =>
      cache.fetch({
        namespace: "conn_1",
        key: JSON.stringify({ name: "pull_request_read", number: 7 }),
        fetchLive: async () => ({ n: ++calls }),
        onRevalidation: () => {},
      });

    await read();
    await cache.invalidate("conn_1");
    await read();
    expect(calls).toBe(2);
  });
});

describe("PR card cache config", () => {
  test("a card that was rendered once never blocks on GitHub again", () => {
    // The card cache exists because the read cache could not make a page
    // refresh fast: past maxStale a value is a MISS and the caller blocks. A
    // day means a card someone opened this morning still paints instantly this
    // afternoon; half an hour (the read cache's window) did not.
    expect(PR_CARDS_CACHE.maxStaleMs).toBeGreaterThan(
      PR_READS_CACHE.maxStaleMs,
    );
    // Under the dialog's 60s poll, so a poll refreshes rather than blocks.
    expect(PR_CARDS_CACHE.revalidateAfterMs).toBeLessThan(60_000);
  });

  test("the two caches cannot invalidate each other", () => {
    expect(PR_CARDS_CACHE.bucket).not.toBe(PR_READS_CACHE.bucket);
  });
});

describe("a value the bucket rejects", () => {
  test("is counted, not silently uncacheable forever", async () => {
    const clock = { now: 0 };
    const cache = new JetStreamKVPrCache(
      PR_READS_CACHE,
      { getJetStream: () => null },
      () => clock.now,
    );
    // A bucket that refuses every put — an oversized value, in practice.
    await cache.init({
      get: async () => null,
      put: async () => {
        throw new Error("maximum value size exceeded");
      },
      delete: async () => {},
      keys: async () => [],
    } as unknown as Parameters<JetStreamKVPrCache["init"]>[0]);

    let calls = 0;
    const read = () =>
      cache.fetch({
        namespace: "conn_1",
        key: "big",
        fetchLive: async () => ({ n: ++calls }),
        onRevalidation: () => {},
      });

    // It still answers — but every read is a live fetch, which is the failure
    // mode the store_rejected counter now makes visible in prod.
    expect(await read()).toEqual({ n: 1 });
    expect(await read()).toEqual({ n: 2 });
  });
});

describe("fetchOrPlaceholder", () => {
  const setup = async (clock: { now: number }) => {
    const cache = new JetStreamKVPrCache(
      PR_CARDS_CACHE,
      { getJetStream: () => null },
      () => clock.now,
    );
    await cache.init(fakeKv());
    return cache;
  };

  test("returns the placeholder without waiting, then serves the real value", async () => {
    const clock = { now: 0 };
    const cache = await setup(clock);
    let release: (v: string) => void = () => {};
    const first = await cache.fetchOrPlaceholder({
      namespace: "org_1",
      key: "task_1",
      fetchLive: () => new Promise<string>((r) => (release = r)),
      placeholder: "from-db",
    });
    // GitHub has not answered and we did not wait for it.
    expect(first).toEqual({ value: "from-db", live: false });

    release("from-github");
    await Promise.resolve();
    await Promise.resolve();

    expect(
      await cache.fetchOrPlaceholder({
        namespace: "org_1",
        key: "task_1",
        fetchLive: async () => "unused",
        placeholder: "from-db",
      }),
    ).toEqual({ value: "from-github", live: true });
  });

  test("a stale value is served as live, not replaced by the placeholder", async () => {
    const clock = { now: 0 };
    const cache = await setup(clock);
    const call = (fetchLive: () => Promise<string>) =>
      cache.fetchOrPlaceholder({
        namespace: "org_1",
        key: "task_1",
        fetchLive,
        placeholder: "from-db",
      });

    await call(async () => "v1");
    await call(async () => "v1");
    clock.now = PR_CARDS_CACHE.revalidateAfterMs + 1;
    // Stale, so it refreshes in the background — but the card on screen stays
    // the last real one. Falling back to the placeholder here would blank a
    // rendered card back to a bare link.
    expect(await call(async () => "v2")).toEqual({ value: "v1", live: true });
  });

  test("past maxStale it falls back to the placeholder rather than blocking", async () => {
    const clock = { now: 0 };
    const cache = await setup(clock);
    const call = (fetchLive: () => Promise<string>) =>
      cache.fetchOrPlaceholder({
        namespace: "org_1",
        key: "task_1",
        fetchLive,
        placeholder: "from-db",
      });

    await call(async () => "v1");
    clock.now = PR_CARDS_CACHE.maxStaleMs + 1;
    expect(await call(async () => "v2")).toEqual({
      value: "from-db",
      live: false,
    });
  });
});
