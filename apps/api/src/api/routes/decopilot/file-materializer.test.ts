import { describe, expect, it } from "bun:test";
import {
  collectStudioStorageKeys,
  MAX_STORAGE_KEYS,
} from "./file-materializer";

describe("collectStudioStorageKeys", () => {
  it("collects every key in a nested tool-call args tree", () => {
    const out = new Set<string>();
    collectStudioStorageKeys(
      {
        a: "studio-storage://one",
        nested: { b: ["studio-storage://two", "plain text"] },
      },
      out,
    );
    expect([...out]).toEqual(["one", "two"]);
  });

  it("caps the number of keys collected from a single string", () => {
    const padded = Array.from(
      { length: MAX_STORAGE_KEYS + 50 },
      (_, i) => `studio-storage://key-${i}`,
    ).join(" ");
    const out = new Set<string>();
    collectStudioStorageKeys(padded, out);
    expect(out.size).toBe(MAX_STORAGE_KEYS);
  });

  it("caps the number of keys collected across many args fields", () => {
    const args: Record<string, string> = {};
    for (let i = 0; i < MAX_STORAGE_KEYS + 50; i++) {
      args[`field${i}`] = `studio-storage://key-${i}`;
    }
    const out = new Set<string>();
    collectStudioStorageKeys(args, out);
    expect(out.size).toBe(MAX_STORAGE_KEYS);
  });
});
