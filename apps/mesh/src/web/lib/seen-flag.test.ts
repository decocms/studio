import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeSeenFlag } from "./seen-flag";

// Minimal in-memory localStorage stub so this stays a pure unit test.
function installStorage(impl: Partial<Storage>) {
  (globalThis as { localStorage?: unknown }).localStorage = impl as Storage;
}

describe("makeSeenFlag", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    installStorage({
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
  });

  test("starts unset, becomes set after mark()", () => {
    const flag = makeSeenFlag("k1");
    expect(flag.has()).toBe(false);
    flag.mark();
    expect(flag.has()).toBe(true);
  });

  test("distinct keys are independent", () => {
    makeSeenFlag("a").mark();
    expect(makeSeenFlag("a").has()).toBe(true);
    expect(makeSeenFlag("b").has()).toBe(false);
  });

  test("has() swallows storage errors and returns false", () => {
    installStorage({
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(makeSeenFlag("k").has()).toBe(false);
  });

  test("mark() swallows storage errors", () => {
    installStorage({
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(() => makeSeenFlag("k").mark()).not.toThrow();
  });
});
