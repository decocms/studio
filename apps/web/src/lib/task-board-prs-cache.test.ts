import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ProjectLocator } from "@/sdk";

// The module early-returns on `typeof window === "undefined"`. Bun's runtime has
// no DOM, so stub a minimal window (with a localStorage) before importing it,
// and clean up after — leaving a fake `window` on globalThis breaks other tests
// that check `typeof window` and then dereference real DOM properties.
const windowStubbedHere = typeof globalThis.window === "undefined";
if (windowStubbedHere) {
  (globalThis as unknown as { window: object }).window = {};
}

let store: Record<string, string> = {};
(globalThis.window as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
};

const { readCachedTaskPrs, writeCachedTaskPrs } = await import(
  "./task-board-prs-cache"
);

afterAll(() => {
  if (windowStubbedHere) {
    delete (globalThis as unknown as { window?: object }).window;
  }
});

const loc = "org/proj" as unknown as ProjectLocator;
const prs = [{ number: 1, title: "Fix it" }];

describe("task board PR localStorage cache", () => {
  beforeEach(() => {
    store = {};
  });

  test("round-trips a task's cards", () => {
    writeCachedTaskPrs(loc, "task-1", prs);
    expect(readCachedTaskPrs(loc, "task-1")?.data).toEqual(prs);
  });

  test("a task that was never written is a miss", () => {
    writeCachedTaskPrs(loc, "task-1", prs);
    expect(readCachedTaskPrs(loc, "task-2")).toBeNull();
  });

  test("an entry older than the max age is a miss, not stale data", () => {
    writeCachedTaskPrs(loc, "task-1", prs);
    const key = Object.keys(store)[0]!;
    const parsed = JSON.parse(store[key]!);
    parsed["task-1"].updatedAt = Date.now() - 25 * 60 * 60 * 1000;
    store[key] = JSON.stringify(parsed);
    expect(readCachedTaskPrs(loc, "task-1")).toBeNull();
  });

  test("keeps the store bounded, evicting the least recently written", () => {
    for (let i = 0; i < 45; i++) writeCachedTaskPrs(loc, `task-${i}`, prs);
    const key = Object.keys(store)[0]!;
    const parsed = JSON.parse(store[key]!) as Record<string, unknown>;
    expect(Object.keys(parsed).length).toBeLessThanOrEqual(40);
    // The newest survives; the oldest is gone.
    expect(readCachedTaskPrs(loc, "task-44")).not.toBeNull();
    expect(readCachedTaskPrs(loc, "task-0")).toBeNull();
  });

  test("corrupt storage reads as a miss instead of throwing", () => {
    store["studio:task-board-prs:org/proj"] = "{not json";
    expect(readCachedTaskPrs(loc, "task-1")).toBeNull();
  });
});
