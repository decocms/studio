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

  test("invalidate drops every key under the namespace, not just the first", async () => {
    const clock = { now: 0 };
    const cache = await cacheAt(clock);
    let calls = 0;
    const read = (number: number) =>
      cache.fetch({
        namespace: "conn_1",
        key: JSON.stringify({ name: "pull_request_read", number }),
        fetchLive: async () => ({ n: ++calls }),
        onRevalidation: () => {},
      });

    await read(1);
    await read(2);
    await read(3);
    expect(calls).toBe(3);

    await cache.invalidate("conn_1");
    await read(1);
    await read(2);
    await read(3);
    expect(calls).toBe(6);
  });
});

describe("fetchOrPlaceholder without KV (NATS down / not yet ready)", () => {
  test("returns the placeholder instead of blocking on fetchLive", async () => {
    const clock = { now: 0 };
    const cache = new JetStreamKVPrCache(
      PR_CARDS_CACHE,
      { getJetStream: () => null },
      () => clock.now,
    );
    // No init() call — this.kv stays null, like a pod not yet connected to NATS.
    let resolveFetch: (() => void) | undefined;
    const fetchLive = () =>
      new Promise<{ n: number }>((resolve) => {
        resolveFetch = () => resolve({ n: 1 });
      });

    const first = await cache.fetchOrPlaceholder({
      namespace: "org_1",
      key: "task_1",
      fetchLive,
      placeholder: { n: 0 },
    });
    expect(first).toEqual({ value: { n: 0 }, live: false });

    resolveFetch?.();
    await new Promise((r) => setTimeout(r, 0));

    const second = await cache.fetchOrPlaceholder({
      namespace: "org_1",
      key: "task_1",
      fetchLive: () => Promise.reject(new Error("should not refetch yet")),
      placeholder: { n: 0 },
    });
    expect(second).toEqual({ value: { n: 1 }, live: true });
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

describe("per-entry revalidate override (a value still awaiting something)", () => {
  test("fetch: a not-ready stored value goes stale immediately", async () => {
    const clock = { now: 0 };
    const cache = await cacheAt(clock);
    let calls = 0;
    const pending: Promise<void>[] = [];
    const read = (ready: boolean) =>
      cache.fetch({
        namespace: "conn_1",
        key: "deployment",
        fetchLive: async () => {
          calls++;
          return { url: ready ? "https://x.vtex.app" : null };
        },
        onRevalidation: (p) => pending.push(p),
        // Not ready -> 0, so the very next read revalidates.
        revalidateAfterMs: (stored) =>
          (stored as { url: string | null }).url === null ? 0 : 55_000,
      });

    await read(false);
    expect(calls).toBe(1);

    // One tick later the default window (55s) would still be a HIT; the
    // override makes it stale, so the deploy's url is picked up on this poll.
    clock.now = 1_000;
    await read(true);
    await Promise.all(pending);
    expect(calls).toBe(2);

    // Now that it IS ready, the default window applies again.
    clock.now = 2_000;
    await read(true);
    await Promise.all(pending);
    expect(calls).toBe(2);
  });

  test("fetchOrPlaceholder: an incomplete card is never a hit", async () => {
    const clock = { now: 0 };
    const cache = new JetStreamKVPrCache(
      PR_CARDS_CACHE,
      { getJetStream: () => null },
      () => clock.now,
    );
    await cache.init(fakeKv());

    let calls = 0;
    const get = (previewUrl: string | null) =>
      cache.fetchOrPlaceholder<{ previewUrl: string | null }>({
        namespace: "org_1",
        key: "task_1",
        fetchLive: async () => {
          calls++;
          return { previewUrl };
        },
        placeholder: { previewUrl: null },
        revalidateAfterMs: (card) =>
          card.previewUrl === null ? 0 : PR_CARDS_CACHE.revalidateAfterMs,
      });

    await get(null); // placeholder + detached fill
    await Bun.sleep(0);
    expect(calls).toBe(1);

    // Inside the 30s default window, so unpatched this was a hit and the
    // preview waited for the window to age out.
    clock.now = 1_000;
    await get("https://x.vtex.app");
    await Bun.sleep(0);
    expect(calls).toBe(2);

    // Complete card: back to the normal window, no rebuild per poll.
    clock.now = 2_000;
    await get("https://x.vtex.app");
    await Bun.sleep(0);
    expect(calls).toBe(2);
  });
});
