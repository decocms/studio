import { describe, expect, test } from "bun:test";
import { upsertCallStartEntries } from "./bash-wait";

describe("upsertCallStartEntries", () => {
  test("adds a new entry", () => {
    expect(upsertCallStartEntries([], "call-1", 100)).toEqual([
      ["call-1", 100],
    ]);
  });

  test("moves an existing entry to the most-recent slot without duplicating it", () => {
    const entries: [string, number][] = [
      ["call-1", 100],
      ["call-2", 200],
    ];
    expect(upsertCallStartEntries(entries, "call-1", 999)).toEqual([
      ["call-2", 200],
      ["call-1", 999],
    ]);
  });

  test("evicts the oldest entry once past the cap", () => {
    const entries: [string, number][] = [
      ["call-1", 100],
      ["call-2", 200],
    ];
    expect(upsertCallStartEntries(entries, "call-3", 300, 2)).toEqual([
      ["call-2", 200],
      ["call-3", 300],
    ]);
  });
});
