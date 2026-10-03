import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys.ts";
import { readProjectFirstNav } from "./use-preferences.ts";

// Bun has no DOM: stand a minimal localStorage in, and put back whatever was
// there so other tests see the runtime they expect.
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  },
});

afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const setPreferences = (value: string) => {
  store[LOCALSTORAGE_KEYS.preferences()] = value;
};

describe("readProjectFirstNav (the New Layout preference)", () => {
  beforeEach(() => {
    store = {};
  });

  test("is off when nothing is stored", () => {
    expect(readProjectFirstNav()).toBe(false);
  });

  test("is on only when projectFirstNav is exactly true", () => {
    setPreferences(JSON.stringify({ projectFirstNav: true }));
    expect(readProjectFirstNav()).toBe(true);
    setPreferences(JSON.stringify({ projectFirstNav: "true" }));
    expect(readProjectFirstNav()).toBe(false);
    setPreferences(JSON.stringify({ projectFirstNav: false }));
    expect(readProjectFirstNav()).toBe(false);
  });

  test("the retired compactPageLayout key does not turn it on", () => {
    setPreferences(JSON.stringify({ compactPageLayout: true }));
    expect(readProjectFirstNav()).toBe(false);
  });

  test("is off when the stored value is not JSON", () => {
    setPreferences("{not json");
    expect(readProjectFirstNav()).toBe(false);
  });
});
