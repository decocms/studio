import { describe, expect, test } from "bun:test";
import {
  sanitizeThreadLayout,
  upsertThreadLayoutEntries,
} from "./thread-layout-memory";

describe("sanitizeThreadLayout", () => {
  test("keeps well-shaped values", () => {
    expect(sanitizeThreadLayout({ main: "git", sidepanel: true })).toEqual({
      main: "git",
      sidepanel: true,
    });
    expect(sanitizeThreadLayout({ main: 0, sidepanel: false })).toEqual({
      main: 0,
      sidepanel: false,
    });
  });

  test("drops absent fields (meaning: use the default)", () => {
    expect(sanitizeThreadLayout({})).toEqual({});
    expect(sanitizeThreadLayout({ main: "git" })).toEqual({ main: "git" });
  });

  test("drops tampered/unexpected values", () => {
    const dirty = {
      main: 5,
      sidepanel: "chat",
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
