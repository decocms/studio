import { describe, expect, test } from "bun:test";
import {
  insertEntryAfter,
  removeEntryAt,
  type ArrayEntry,
} from "./array-entries";

describe("insertEntryAfter", () => {
  test("duplicating a non-last item shifts later entries instead of colliding with them", () => {
    // items: [A, B, C]; duplicating A (index 0) yields [A, copyA, B, C].
    const entries: ArrayEntry[] = [
      { id: "a", index: 0 },
      { id: "b", index: 1 },
      { id: "c", index: 2 },
    ];
    const next = insertEntryAfter(entries, 0);
    // "b" (originally B) must point at B's new position (2) — a naive
    // append-at-the-end resize would leave it at 1, which is now the copy's
    // slot, so the row keyed "b" would render the copy's label instead of B's.
    expect(next.find((e) => e.id === "b")?.index).toBe(2);
    expect(next.find((e) => e.id === "c")?.index).toBe(3);
    expect(next.find((e) => e.id === "a")?.index).toBe(0);
    const inserted = next.find(
      (e) => e.id !== "a" && e.id !== "b" && e.id !== "c",
    );
    expect(inserted?.index).toBe(1);
  });

  test("duplicating the last item just appends", () => {
    const entries: ArrayEntry[] = [
      { id: "a", index: 0 },
      { id: "b", index: 1 },
    ];
    const next = insertEntryAfter(entries, 1);
    expect(next.map((e) => e.index)).toEqual([0, 1, 2]);
  });
});

describe("removeEntryAt", () => {
  test("removing a non-last item drops its entry and shifts later ones down", () => {
    // items: [A, B, C]; removing A (index 0) yields [B, C].
    const entries: ArrayEntry[] = [
      { id: "a", index: 0 },
      { id: "b", index: 1 },
      { id: "c", index: 2 },
    ];
    const next = removeEntryAt(entries, 0);
    expect(next.find((e) => e.id === "a")).toBeUndefined();
    // "b" (originally B) must now point at index 0, matching B's new position.
    expect(next.find((e) => e.id === "b")?.index).toBe(0);
    expect(next.find((e) => e.id === "c")?.index).toBe(1);
  });
});
