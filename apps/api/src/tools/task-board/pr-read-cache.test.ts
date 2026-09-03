import { describe, expect, test } from "bun:test";
import type { KV } from "@nats-io/kv";
import { JetStreamKVPrReadCache } from "./pr-read-cache";

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
  const cache = new JetStreamKVPrReadCache(
    { getJetStream: () => null },
    () => clock.now,
  );
  await cache.init(fakeKv());
  return cache;
}

describe("JetStreamKVPrReadCache", () => {
  test("serves the stored read, then revalidates in the background once stale", async () => {
    const clock = { now: 0 };
    const cache = await cacheAt(clock);
    let calls = 0;
    const pending: Promise<void>[] = [];
    const read = () =>
      cache.fetch({
        connectionId: "conn_1",
        name: "pull_request_read",
        args: { number: 7 },
        fetchLive: async () => ({ n: ++calls }),
        onRevalidation: (p) => pending.push(p),
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
        connectionId: "conn_1",
        name: "pull_request_read",
        args: { number: 7 },
        fetchLive: async () => {
          if (fail) throw new Error("too many requests");
          return { ok: true };
        },
        onRevalidation: (p) => pending.push(p),
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
        connectionId: "conn_1",
        name: "pull_request_read",
        args: { number: 7 },
        fetchLive: async () => ({ n: ++calls }),
        onRevalidation: () => {},
      });

    await read();
    await cache.invalidate("conn_1");
    await read();
    expect(calls).toBe(2);
  });
});
