import { describe, expect, test } from "bun:test";
import { migrateLegacyStorageKeys } from "./legacy-storage";

function storageWith(entries: Record<string, string>): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("migrateLegacyStorageKeys", () => {
  test("copies colon and dash namespaced values without deleting legacy data", () => {
    const storage = storageWith({
      "mesh:user:preferences": '{"theme":"dark"}',
      "mesh-connections-filter": "true",
    });

    migrateLegacyStorageKeys(storage);

    expect(storage.getItem("studio:user:preferences")).toBe('{"theme":"dark"}');
    expect(storage.getItem("studio-connections-filter")).toBe("true");
    expect(storage.getItem("mesh:user:preferences")).not.toBeNull();
  });

  test("does not overwrite an existing Studio value", () => {
    const storage = storageWith({
      "mesh:last-location": "/old",
      "studio:last-location": "/new",
    });

    migrateLegacyStorageKeys(storage);

    expect(storage.getItem("studio:last-location")).toBe("/new");
  });
});
