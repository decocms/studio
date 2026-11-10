import { describe, expect, it } from "bun:test";
import {
  createStaleBuildReload,
  isStaleAssetError,
} from "./stale-build-reload";

const STORAGE_KEY = "__studio_stale_build_reload";

function setup(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(STORAGE_KEY, initial);
  let now = 1_000_000;
  const scheduled: number[] = [];
  let reloads = 0;
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const env = {
    storage: () => storage,
    reload: () => {
      reloads++;
    },
    schedule: (fn: () => void, delayMs: number) => {
      scheduled.push(delayMs);
      fn();
    },
    now: () => now,
  };
  return {
    store,
    scheduled,
    reloads: () => reloads,
    advance: (ms: number) => {
      now += ms;
    },
    /** Each page load gets a fresh instance, as after a real reload. */
    page: () => createStaleBuildReload(env),
  };
}

describe("isStaleAssetError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://example.com/assets/a-1.js",
    "error loading dynamically imported module: https://example.com/assets/a-1.js",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/shell-layout-1.css",
  ])("matches %s", (message) => {
    expect(isStaleAssetError(new TypeError(message))).toBe(true);
  });

  it("does not match a plain network failure or a non-error", () => {
    expect(isStaleAssetError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isStaleAssetError(new Error("Failed to fetch"))).toBe(false);
    expect(
      isStaleAssetError("Failed to fetch dynamically imported module"),
    ).toBe(false);
    expect(isStaleAssetError(null)).toBe(false);
  });
});

describe("createStaleBuildReload", () => {
  it("reloads immediately first, then backs off on each repeat failure", () => {
    const t = setup();
    for (let i = 0; i < 4; i++) {
      expect(t.page().schedule()).toEqual({ status: "scheduled" });
      t.advance(1_000);
    }
    expect(t.scheduled).toEqual([0, 2_000, 5_000, 10_000]);
    expect(t.reloads()).toBe(4);
  });

  it("schedules one reload per page however many errors it sees", () => {
    const t = setup();
    const page = t.page();
    page.schedule();
    page.schedule();
    page.schedule();
    expect(t.scheduled).toEqual([0]);
  });

  it("stops reloading after the last backoff step", () => {
    const t = setup();
    let result = t.page().schedule();
    while (result.status === "scheduled") {
      t.advance(1_000);
      result = t.page().schedule();
    }
    expect(t.scheduled).toHaveLength(10);
    expect(t.reloads()).toBe(10);
  });

  it("starts a new episode once the last reload is old enough", () => {
    const t = setup();
    t.page().schedule();
    t.page().schedule();
    t.advance(6 * 60_000);
    t.page().schedule();
    expect(t.scheduled).toEqual([0, 2_000, 0]);
  });

  it("restarts the backoff after a manual refresh", () => {
    const t = setup();
    t.page().schedule();
    t.page().schedule();
    t.page().reloadNow();
    expect(t.store.has(STORAGE_KEY)).toBe(false);
    t.page().schedule();
    expect(t.scheduled).toEqual([0, 2_000, 0]);
  });

  it.each(["not json", '{"attempt":-1,"reloadAt":0}', '{"attempt":"2"}'])(
    "treats a corrupt stored state (%s) as a first attempt",
    (raw) => {
      const t = setup(raw);
      t.page().schedule();
      expect(t.scheduled).toEqual([0]);
    },
  );

  it("still reloads when storage is blocked", () => {
    const t = setup();
    const page = createStaleBuildReload({
      storage: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      reload: () => {},
      schedule: (_fn, delayMs) => t.scheduled.push(delayMs),
      now: () => 0,
    });
    expect(page.schedule()).toEqual({ status: "scheduled" });
    expect(t.scheduled).toEqual([0]);
  });
});
