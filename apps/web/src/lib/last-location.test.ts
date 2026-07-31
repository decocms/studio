import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  claimRestoreStateFor,
  clearRestoreState,
  consumeRestoreRedirect,
  markRestoreRedirect,
  readLastLocation,
  saveLastLocation,
} from "./last-location";
import { LOCALSTORAGE_KEYS } from "./localstorage-keys";

// Whether the web storages exist depends on whether some other test file
// registered happy-dom first, so install our own and put the originals back.
const NAMES = ["localStorage", "sessionStorage"] as const;
const originals = NAMES.map((n) =>
  Object.getOwnPropertyDescriptor(globalThis, n),
);

function stubStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

beforeEach(() => {
  for (const name of NAMES) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: stubStorage(),
    });
  }
});

afterAll(() => {
  NAMES.forEach((name, i) => {
    const original = originals[i];
    if (original) Object.defineProperty(globalThis, name, original);
    else delete (globalThis as Partial<typeof globalThis>)[name];
  });
});

describe("claimRestoreStateFor", () => {
  test("drops another principal's restore state", () => {
    saveLastLocation({ org: "ferragens-floresta" });
    localStorage.setItem(LOCALSTORAGE_KEYS.lastOrgSlug(), "ferragens-floresta");
    claimRestoreStateFor("user-a");

    claimRestoreStateFor("user-b");

    expect(readLastLocation()).toBeNull();
    expect(localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug())).toBeNull();
  });

  test("keeps the owning principal's restore state", () => {
    claimRestoreStateFor("user-a");
    saveLastLocation({ org: "acme", taskId: "t1" });

    claimRestoreStateFor("user-a");

    expect(readLastLocation()).toEqual({
      org: "acme",
      taskId: "t1",
      virtualmcpid: undefined,
    });
  });
});

// The marker's read is memoized for the page load (see consumeRestoreRedirect),
// so these run unmarked-first — module state is the page load here.
describe("restore redirect marker", () => {
  test("unmarked navigation is not a restore", () => {
    expect(consumeRestoreRedirect("acme")).toBe(false);
  });

  test("matches the marked org exactly", () => {
    markRestoreRedirect("acme");

    expect(consumeRestoreRedirect("other")).toBe(false);
  });

  test("reports a restore-driven arrival, stably across re-reads", () => {
    markRestoreRedirect("acme");

    expect(consumeRestoreRedirect("acme")).toBe(true);
    // A re-render must get the same answer, not "you asked for this org".
    expect(consumeRestoreRedirect("acme")).toBe(true);
    // ...but the marker itself is gone, so the next page load starts clean.
    expect(sessionStorage.getItem("studio:restore-redirect")).toBeNull();
  });
});

test("clearRestoreState forgets both keys", () => {
  saveLastLocation({ org: "acme" });
  localStorage.setItem(LOCALSTORAGE_KEYS.lastOrgSlug(), "acme");

  clearRestoreState();

  expect(readLastLocation()).toBeNull();
  expect(localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug())).toBeNull();
});
