import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import {
  clearPersistedQueryCache,
  hydrateQueryClient,
  persistQueryClient,
  readCachedOrg,
  wasOrgCacheRestored,
  writeCachedOrg,
} from "./query-persist";
import { KEYS } from "./query-keys";

// Vite `define`s this at build time; bun test has no such pass.
declare const __STUDIO_VERSION__: string;
(globalThis as unknown as Record<string, string>).__STUDIO_VERSION__ ??=
  "test-version";

// readCachedOrg/writeCachedOrg early-return when `window` is undefined. Bun's
// test runtime has no DOM, so stub a minimal window + localStorage.
const windowStubbedHere = typeof globalThis.window === "undefined";

function stubLocalStorage() {
  const store: Record<string, string> = {};
  return {
    store,
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

let localStorageStub: ReturnType<typeof stubLocalStorage>;

beforeAll(() => {
  if (windowStubbedHere) {
    (globalThis as unknown as { window: object }).window = new EventTarget();
  }
});

afterAll(() => {
  if (windowStubbedHere) {
    delete (globalThis as { window?: unknown }).window;
  }
});

beforeEach(() => {
  localStorageStub = stubLocalStorage();
  (globalThis.window as { localStorage?: unknown }).localStorage =
    localStorageStub;
});

describe("readCachedOrg/writeCachedOrg", () => {
  // Must run before any other successful read in this file: wasOrgCacheRestored
  // is a one-way latch for the module's lifetime, so this is the only place we
  // can observe its pre-hit "false" state.
  test("misses for an unknown slug or user without flipping wasOrgCacheRestored", () => {
    writeCachedOrg("user-3", "acme", { name: "Acme" });
    expect(readCachedOrg("user-3", "other-slug")).toBeNull();
    expect(readCachedOrg("unknown-user", "acme")).toBeNull();
    expect(wasOrgCacheRestored()).toBe(false);

    readCachedOrg("user-3", "acme");
    expect(wasOrgCacheRestored()).toBe(true);
  });

  test("round-trips a written entry", () => {
    writeCachedOrg("user-1", "acme", { name: "Acme" });
    expect(readCachedOrg("user-1", "acme")).toEqual({
      data: { name: "Acme" },
      updatedAt: expect.any(Number),
    });
  });

  test("keeps entries for different users isolated under the same slug", () => {
    writeCachedOrg("user-a", "acme", { name: "A's view" });
    writeCachedOrg("user-b", "acme", { name: "B's view" });
    expect(readCachedOrg("user-a", "acme")?.data).toEqual({
      name: "A's view",
    });
    expect(readCachedOrg("user-b", "acme")?.data).toEqual({
      name: "B's view",
    });
  });

  test("expires entries older than 24h", () => {
    const key = "studio:org-cache:user-4";
    localStorageStub.setItem(
      key,
      JSON.stringify({
        acme: {
          data: { name: "Stale" },
          updatedAt: Date.now() - 25 * 60 * 60 * 1000,
        },
      }),
    );
    expect(readCachedOrg("user-4", "acme")).toBeNull();
  });

  test("returns null on corrupt JSON instead of throwing", () => {
    localStorageStub.setItem("studio:org-cache:user-5", "{not json");
    expect(readCachedOrg("user-5", "acme")).toBeNull();
  });

  test("caps the per-user map at 20 orgs, evicting the least-recently-updated", () => {
    const key = "studio:org-cache:user-7";
    const stale: Record<string, { data: unknown; updatedAt: number }> = {};
    for (let i = 0; i < 20; i++) {
      stale[`org-${i}`] = { data: { n: i }, updatedAt: Date.now() - (20 - i) };
    }
    localStorageStub.setItem(key, JSON.stringify(stale));

    writeCachedOrg("user-7", "org-new", { n: 20 });

    const raw = localStorageStub.getItem(key);
    expect(Object.keys(JSON.parse(raw ?? "{}"))).toHaveLength(20);
    expect(readCachedOrg("user-7", "org-0")).toBeNull();
    expect(readCachedOrg("user-7", "org-19")?.data).toEqual({ n: 19 });
    expect(readCachedOrg("user-7", "org-new")?.data).toEqual({ n: 20 });
  });

  test("prunes expired entries out of the map on write, not just on read", () => {
    const key = "studio:org-cache:user-8";
    localStorageStub.setItem(
      key,
      JSON.stringify({
        stale: {
          data: { name: "Stale" },
          updatedAt: Date.now() - 25 * 60 * 60 * 1000,
        },
      }),
    );

    writeCachedOrg("user-8", "fresh", { name: "Fresh" });

    const raw = localStorageStub.getItem(key);
    expect(Object.keys(JSON.parse(raw ?? "{}"))).toEqual(["fresh"]);
  });
});

describe("persistQueryClient", () => {
  test("cancels a pending debounced write once unsubscribed", async () => {
    const queryClient = new QueryClient();
    const unsubscribe = persistQueryClient(queryClient);

    queryClient.setQueryData(["publicConfig"], { theme: "dark" });
    unsubscribe();
    window.dispatchEvent(new Event("pagehide"));

    // The debounced write would have fired by now had it not been cancelled.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(localStorageStub.getItem("studio:rq-cache")).toBeNull();
  });
});

describe("clearPersistedQueryCache", () => {
  test("removes org-cache entries but leaves unrelated keys", () => {
    writeCachedOrg("user-6", "acme", { name: "Acme" });
    localStorageStub.setItem("unrelated-key", "keep-me");

    clearPersistedQueryCache();

    expect(readCachedOrg("user-6", "acme")).toBeNull();
    expect(localStorageStub.getItem("unrelated-key")).toBe("keep-me");
  });
});

describe("hydrateQueryClient", () => {
  // publicConfig carries the deployment flags (STUDIO_PLANS_ENABLED among
  // them). Those flip server-side with no version bump, so the hydrated entry
  // must not be allowed to answer for them on its original fetch time.
  function persist(
    entries: Array<[readonly unknown[], Record<string, unknown>]>,
  ) {
    const source = new QueryClient();
    for (const [key, data] of entries) {
      source.setQueryData<Record<string, unknown>>(key, data);
    }
    localStorageStub.setItem(
      "studio:rq-cache",
      JSON.stringify({
        buster: __STUDIO_VERSION__,
        timestamp: Date.now(),
        state: dehydrate(source, { shouldDehydrateQuery: () => true }),
      }),
    );
  }

  test("hydrates publicConfig but marks it for revalidation", () => {
    persist([[KEYS.publicConfig(), { plansEnabled: false }]]);

    const client = new QueryClient();
    hydrateQueryClient(client);

    // Still paints instantly — the data is there.
    expect(
      client.getQueryData<Record<string, unknown>>(KEYS.publicConfig()),
    ).toEqual({
      plansEnabled: false,
    });
    // ...but is invalidated, so refetchOnMount refetches it regardless of
    // staleTime. Without this a restart with a flipped flag stayed invisible.
    expect(client.getQueryState(KEYS.publicConfig())?.isInvalidated).toBe(true);
  });

  test("leaves other persisted entries alone", () => {
    persist([
      [KEYS.publicConfig(), { plansEnabled: false }],
      [["organization-settings", "acme"], { flags: {} }],
    ]);

    const client = new QueryClient();
    hydrateQueryClient(client);

    expect(
      client.getQueryState(["organization-settings", "acme"])?.isInvalidated,
    ).toBe(false);
  });
});
