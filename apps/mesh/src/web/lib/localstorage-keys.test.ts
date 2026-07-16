import { describe, expect, test } from "bun:test";
import { migrateLegacyLocalStorageKeys } from "./localstorage-keys";

function fakeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("migrateLegacyLocalStorageKeys", () => {
  test("copies mesh:* and mesh-* keys to studio names and removes the old ones", () => {
    const storage = fakeStorage({
      "mesh:user:preferences": '{"theme":"dark"}',
      "mesh-connections-org1": "table",
      "sidebar.group-order.o.u": "keep-me",
    });
    migrateLegacyLocalStorageKeys(storage);
    expect(Object.fromEntries(storage.map)).toEqual({
      "studio:user:preferences": '{"theme":"dark"}',
      "studio-connections-org1": "table",
      "sidebar.group-order.o.u": "keep-me",
    });
  });

  test("never overwrites an existing studio:* value", () => {
    const storage = fakeStorage({
      "mesh:last-org-slug": "old-org",
      "studio:last-org-slug": "new-org",
    });
    migrateLegacyLocalStorageKeys(storage);
    expect(storage.getItem("studio:last-org-slug")).toBe("new-org");
    expect(storage.getItem("mesh:last-org-slug")).toBeNull();
  });
});
