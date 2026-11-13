import { describe, expect, test } from "bun:test";
import {
  captureLegacyAdminArrival,
  clearLegacyAdminArrival,
  hasLegacyAdminArrival,
} from "./legacy-admin-arrival";

class MemoryStorage {
  private items = new Map<string, string>();

  getItem(key: string) {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.items.set(key, value);
  }

  removeItem(key: string) {
    this.items.delete(key);
  }
}

class ThrowingStorage {
  getItem(): string | null {
    throw new Error("storage unavailable");
  }

  setItem(): void {
    throw new Error("storage unavailable");
  }

  removeItem(): void {
    throw new Error("storage unavailable");
  }
}

describe("legacy admin arrival", () => {
  test("captures the marker from the redirect query", () => {
    const storage = new MemoryStorage();
    captureLegacyAdminArrival("?from=legacy-admin", storage);
    expect(hasLegacyAdminArrival(storage)).toBe(true);
  });

  test("captures the marker alongside other params", () => {
    const storage = new MemoryStorage();
    captureLegacyAdminArrival("?next=%2Ffoo&from=legacy-admin", storage);
    expect(hasLegacyAdminArrival(storage)).toBe(true);
  });

  test("captures the marker from a login redirect's next", () => {
    const storage = new MemoryStorage();
    captureLegacyAdminArrival("?next=%2F%3Ffrom%3Dlegacy-admin", storage);
    expect(hasLegacyAdminArrival(storage)).toBe(true);
  });

  test("ignores a next without the marker or off this origin", () => {
    for (const search of [
      "?next=%2F",
      "?next=%2Ffoo%3Ffrom%3Dother",
      "?next=https%3A%2F%2Fexample.test%2F%3Ffrom%3Dlegacy-admin",
      "?next=",
    ]) {
      const storage = new MemoryStorage();
      captureLegacyAdminArrival(search, storage);
      expect(hasLegacyAdminArrival(storage)).toBe(false);
    }
  });

  test("ignores a missing, empty, or different marker", () => {
    for (const search of [
      "",
      "?",
      "?from=",
      "?from=other",
      "?from=LEGACY-ADMIN",
      "?legacy-admin",
    ]) {
      const storage = new MemoryStorage();
      captureLegacyAdminArrival(search, storage);
      expect(hasLegacyAdminArrival(storage)).toBe(false);
    }
  });

  test("capturing twice keeps a single pending arrival", () => {
    const storage = new MemoryStorage();
    captureLegacyAdminArrival("?from=legacy-admin", storage);
    captureLegacyAdminArrival("?from=legacy-admin", storage);
    clearLegacyAdminArrival(storage);
    expect(hasLegacyAdminArrival(storage)).toBe(false);
  });

  test("a visit without the marker keeps a pending arrival", () => {
    const storage = new MemoryStorage();
    captureLegacyAdminArrival("?from=legacy-admin", storage);
    captureLegacyAdminArrival("", storage);
    expect(hasLegacyAdminArrival(storage)).toBe(true);
  });

  test("treats unavailable storage as no arrival", () => {
    const storage = new ThrowingStorage();
    expect(() =>
      captureLegacyAdminArrival("?from=legacy-admin", storage),
    ).not.toThrow();
    expect(hasLegacyAdminArrival(storage)).toBe(false);
    expect(() => clearLegacyAdminArrival(storage)).not.toThrow();
  });
});
