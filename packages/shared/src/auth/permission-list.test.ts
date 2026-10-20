import { describe, expect, it } from "bun:test";
import {
  listFromFilter,
  listsAllow,
  permissionListFilter,
  unionListFilters,
} from "./permission-list";

describe("listsAllow", () => {
  it("grants listed names and everything under *", () => {
    expect(listsAllow([["a"]], "a")).toBe(true);
    expect(listsAllow([["a"]], "b")).toBe(false);
    expect(listsAllow([["*"]], "b")).toBe(true);
  });

  it("lets a denial win over * in the same list", () => {
    expect(listsAllow([["*", "!b"]], "a")).toBe(true);
    expect(listsAllow([["*", "!b"]], "b")).toBe(false);
  });

  it("lets a denial win over a grant in another list", () => {
    expect(listsAllow([["b"], ["!b"]], "b")).toBe(false);
    expect(listsAllow([["*"], ["!*"]], "a")).toBe(false);
  });

  it("denies when no list grants, including empty and absent lists", () => {
    expect(listsAllow([[]], "a")).toBe(false);
    expect(listsAllow([undefined, null], "a")).toBe(false);
    expect(listsAllow([["!a"]], "b")).toBe(false);
  });
});

describe("permissionListFilter", () => {
  it("reads * as all, and * with denials as all except them", () => {
    expect(permissionListFilter(["*"])).toEqual({ kind: "all" });
    expect(permissionListFilter(["*", "!a", "!b"])).toEqual({
      kind: "except",
      names: ["a", "b"],
    });
  });

  it("reads names as only them, less any denied", () => {
    expect(permissionListFilter(["a", "b", "!b"])).toEqual({
      kind: "only",
      names: ["a"],
    });
    expect(permissionListFilter([])).toEqual({ kind: "only", names: [] });
  });

  it("reads !* as nothing, whatever else is listed", () => {
    expect(permissionListFilter(["*", "a", "!*"])).toEqual({
      kind: "only",
      names: [],
    });
  });

  it("round-trips through listFromFilter", () => {
    for (const list of [["*"], ["*", "!a"], ["a", "b"], []]) {
      const filter = permissionListFilter(list);
      expect(permissionListFilter(listFromFilter(filter))).toEqual(filter);
    }
  });
});

describe("unionListFilters", () => {
  it("is all when any filter is all", () => {
    expect(
      unionListFilters([{ kind: "only", names: ["a"] }, { kind: "all" }]),
    ).toEqual({ kind: "all" });
  });

  it("keeps only what every except-filter excludes and no only-filter adds", () => {
    expect(
      unionListFilters([
        { kind: "except", names: ["a", "b"] },
        { kind: "except", names: ["b", "c"] },
        { kind: "only", names: ["b"] },
      ]),
    ).toEqual({ kind: "all" });
    expect(
      unionListFilters([
        { kind: "except", names: ["a", "b"] },
        { kind: "only", names: ["a"] },
      ]),
    ).toEqual({ kind: "except", names: ["b"] });
  });

  it("joins only-filters, and is nothing for no filters", () => {
    expect(
      unionListFilters([
        { kind: "only", names: ["a"] },
        { kind: "only", names: ["b"] },
      ]),
    ).toEqual({ kind: "only", names: ["a", "b"] });
    expect(unionListFilters([])).toEqual({ kind: "only", names: [] });
  });
});
