import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearLastLocation,
  readLastLocation,
  saveLastLocation,
} from "./last-location";

/** Minimal localStorage stub — Bun's test runtime has no DOM/localStorage. */
function stubLocalStorage(seed: Record<string, string> = {}) {
  const store: Record<string, string> = { ...seed };
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
}

describe("last-location", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage =
      stubLocalStorage();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test("round-trips a full location", () => {
    saveLastLocation({ org: "acme", taskId: "t1", virtualmcpid: "v1" });
    expect(readLastLocation()).toEqual({
      org: "acme",
      taskId: "t1",
      virtualmcpid: "v1",
    });
  });

  test("returns null when nothing is stored", () => {
    expect(readLastLocation()).toBeNull();
  });

  test("returns null for corrupt JSON", () => {
    (globalThis.localStorage as Storage).setItem(
      "mesh:last-location",
      "not json",
    );
    expect(readLastLocation()).toBeNull();
  });

  test("returns null when org is missing or not a string", () => {
    (globalThis.localStorage as Storage).setItem(
      "mesh:last-location",
      JSON.stringify({ taskId: "t1" }),
    );
    expect(readLastLocation()).toBeNull();
  });

  test("drops non-string taskId/virtualmcpid but keeps org", () => {
    (globalThis.localStorage as Storage).setItem(
      "mesh:last-location",
      JSON.stringify({ org: "acme", taskId: 42, virtualmcpid: null }),
    );
    expect(readLastLocation()).toEqual({ org: "acme" });
  });

  test("clearLastLocation removes the stored value", () => {
    saveLastLocation({ org: "acme" });
    clearLastLocation();
    expect(readLastLocation()).toBeNull();
  });

  test("save/read/clear swallow localStorage failures", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveLastLocation({ org: "acme" })).not.toThrow();
    expect(readLastLocation()).toBeNull();
    expect(() => clearLastLocation()).not.toThrow();
  });
});
