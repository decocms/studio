import { describe, expect, it } from "bun:test";
import { dedupePagedBranches } from "./use-branches";

describe("dedupePagedBranches", () => {
  it("flattens pages in order", () => {
    expect(
      dedupePagedBranches([
        { branches: [{ name: "main" }] },
        { branches: [{ name: "feat/a" }] },
      ]),
    ).toEqual([
      { name: "main", author: null },
      { name: "feat/a", author: null },
    ]);
  });

  it("lets the last page win when a branch repeats across pages", () => {
    expect(
      dedupePagedBranches([
        { branches: [{ name: "main", commit: { author: { login: "old" } } }] },
        { branches: [{ name: "main", commit: { author: { login: "new" } } }] },
      ]),
    ).toEqual([{ name: "main", author: "new" }]);
  });

  it("reads an author given as a bare string", () => {
    expect(
      dedupePagedBranches([
        { branches: [{ name: "main", commit: { author: "octocat" } }] },
      ]),
    ).toEqual([{ name: "main", author: "octocat" }]);
  });

  it("nulls a missing or malformed author", () => {
    expect(
      dedupePagedBranches([
        { branches: [{ name: "a", commit: null }, { name: "b" }] },
      ]),
    ).toEqual([
      { name: "a", author: null },
      { name: "b", author: null },
    ]);
  });

  it("drops entries with no name", () => {
    expect(dedupePagedBranches([{ branches: [{}, { name: "main" }] }])).toEqual(
      [{ name: "main", author: null }],
    );
  });

  it("returns empty for undefined pages", () => {
    expect(dedupePagedBranches(undefined)).toEqual([]);
  });
});
