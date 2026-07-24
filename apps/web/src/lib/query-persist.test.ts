import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  clearPersistedQueryCache,
  readCachedOrg,
  wasOrgCacheRestored,
  writeCachedOrg,
} from "./query-persist";

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
    (globalThis as unknown as { window: object }).window = {};
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
