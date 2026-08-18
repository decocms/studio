import { describe, expect, test } from "bun:test";
import {
  sanitizeThreadLayout,
  upsertThreadLayoutEntries,
} from "./thread-layout-memory";

describe("sanitizeThreadLayout", () => {
  test("keeps well-shaped values", () => {
    expect(sanitizeThreadLayout({ main: "git", sidepanel: "chat" })).toEqual({
      main: "git",
      sidepanel: "chat",
    });
    expect(sanitizeThreadLayout({ main: 0, sidepanel: 0 })).toEqual({
      main: 0,
      sidepanel: 0,
    });
  });

  test("keeps the cms side panel — it must survive a thread round-trip", () => {
    expect(sanitizeThreadLayout({ main: "preview", sidepanel: "cms" })).toEqual(
      {
        main: "preview",
        sidepanel: "cms",
      },
    );
  });

  test("drops absent fields (meaning: use the default)", () => {
    expect(sanitizeThreadLayout({})).toEqual({});
    expect(sanitizeThreadLayout({ main: "git" })).toEqual({ main: "git" });
  });

  test("drops tampered/unexpected values", () => {
    const dirty = {
      main: 5,
      sidepanel: "tasks",
      extra: "x",
    } as unknown as Parameters<typeof sanitizeThreadLayout>[0];
    expect(sanitizeThreadLayout(dirty)).toEqual({});
  });
});

describe("upsertThreadLayoutEntries", () => {
  test("appends a new entry as most-recent (last)", () => {
    const out = upsertThreadLayoutEntries([], "a", { main: "git" });
    expect(out).toEqual([["a", { main: "git" }]]);
  });

  test("moves an existing entry to most-recent and replaces its layout", () => {
    const out = upsertThreadLayoutEntries(
      [
        ["a", { main: "git" }],
        ["b", { main: "preview" }],
      ],
      "a",
      { main: "settings" },
    );
    expect(out).toEqual([
      ["b", { main: "preview" }],
      ["a", { main: "settings" }],
    ]);
  });

  test("sanitizes on write", () => {
    const dirty = { main: "git", junk: 1 } as unknown as Parameters<
      typeof upsertThreadLayoutEntries
    >[2];
    expect(upsertThreadLayoutEntries([], "a", dirty)).toEqual([
      ["a", { main: "git" }],
    ]);
  });

  test("evicts the oldest entries past the cap", () => {
    const out = upsertThreadLayoutEntries(
      [
        ["a", {}],
        ["b", {}],
      ],
      "c",
      {},
      2,
    );
    // "a" (oldest) evicted; "c" is newest.
    expect(out.map(([id]) => id)).toEqual(["b", "c"]);
  });
});

describe("sanitizeThreadLayout — editing mode", () => {
  test("keeps both modes", () => {
    expect(sanitizeThreadLayout({ mode: "cms" }).mode).toBe("cms");
    expect(sanitizeThreadLayout({ mode: "vibecoding" }).mode).toBe(
      "vibecoding",
    );
  });

  /** Storage is tamperable, and an unknown mode must read as "no memory"
   *  rather than reach the gate that decides the preview's origin. */
  test("drops anything that is not a known mode", () => {
    expect(
      sanitizeThreadLayout({ mode: "nonsense" as never }).mode,
    ).toBeUndefined();
    expect(sanitizeThreadLayout({}).mode).toBeUndefined();
  });

  test("survives a round trip alongside the panel state", () => {
    const layout = sanitizeThreadLayout({
      main: "preview",
      sidepanel: "cms",
      mode: "vibecoding",
    });
    expect(layout).toEqual({
      main: "preview",
      sidepanel: "cms",
      mode: "vibecoding",
    });
  });
});
