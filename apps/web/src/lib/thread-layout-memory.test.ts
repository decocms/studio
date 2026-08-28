import { describe, expect, test } from "bun:test";
import {
  sanitizeThreadLayout,
  upsertThreadLayoutEntries,
} from "./thread-layout-memory";

describe("sanitizeThreadLayout", () => {
  test("keeps well-shaped values", () => {
    expect(sanitizeThreadLayout({ tab: "git", sidepanel: true })).toEqual({
      tab: "git",
      sidepanel: true,
    });
    expect(
      sanitizeThreadLayout({ tab: "git", mainpanel: false, sidepanel: false }),
    ).toEqual({ tab: "git", mainpanel: false, sidepanel: false });
  });

  test("drops absent fields (meaning: use the default)", () => {
    expect(sanitizeThreadLayout({})).toEqual({});
    expect(sanitizeThreadLayout({ tab: "git" })).toEqual({ tab: "git" });
  });

  test("drops tampered/unexpected values", () => {
    const dirty = {
      tab: 5,
      mainpanel: "0",
      sidepanel: "chat",
      extra: "x",
    } as unknown as Parameters<typeof sanitizeThreadLayout>[0];
    expect(sanitizeThreadLayout(dirty)).toEqual({});
  });
});

describe("upsertThreadLayoutEntries", () => {
  test("appends a new entry as most-recent (last)", () => {
    const out = upsertThreadLayoutEntries([], "a", { tab: "git" });
    expect(out).toEqual([["a", { tab: "git" }]]);
  });

  test("moves an existing entry to most-recent and replaces its layout", () => {
    const out = upsertThreadLayoutEntries(
      [
        ["a", { tab: "git" }],
        ["b", { tab: "preview" }],
      ],
      "a",
      { tab: "settings" },
    );
    expect(out).toEqual([
      ["b", { tab: "preview" }],
      ["a", { tab: "settings" }],
    ]);
  });

  test("sanitizes on write", () => {
    const dirty = { tab: "git", junk: 1 } as unknown as Parameters<
      typeof upsertThreadLayoutEntries
    >[2];
    expect(upsertThreadLayoutEntries([], "a", dirty)).toEqual([
      ["a", { tab: "git" }],
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
