import { describe, expect, it } from "bun:test";
import type { Release } from "@decocms/shared/sdk/types";
import { addRelease, removeRelease, renameReleaseIn } from "./release-edits";

const rel = (branch: string, name = branch): Release => ({
  branch,
  name,
  color: "orange",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("release-edits", () => {
  it("addRelease appends a new branch", () => {
    expect(addRelease([rel("a")], rel("b"))).toEqual([rel("a"), rel("b")]);
  });

  it("addRelease is idempotent by branch (no duplicate draft)", () => {
    const current = [rel("a")];
    expect(addRelease(current, rel("a", "renamed"))).toBe(current);
  });

  it("removeRelease drops only the matching branch", () => {
    expect(removeRelease([rel("a"), rel("b")], "a")).toEqual([rel("b")]);
  });

  it("renameReleaseIn renames only the matching branch", () => {
    expect(renameReleaseIn([rel("a"), rel("b")], "a", "New")).toEqual([
      rel("a", "New"),
      rel("b"),
    ]);
  });

  // Serialized publish discard + auto-name landing compose either way.
  describe("publish landing never resurrects the merged draft", () => {
    const start = [rel("published")];

    it("discard-then-land", () => {
      const out = addRelease(removeRelease(start, "published"), rel("fresh"));
      expect(out).toEqual([rel("fresh")]);
    });

    it("land-then-discard", () => {
      const out = removeRelease(addRelease(start, rel("fresh")), "published");
      expect(out).toEqual([rel("fresh")]);
    });
  });
});
