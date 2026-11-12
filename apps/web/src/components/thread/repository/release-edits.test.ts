import { describe, expect, it } from "bun:test";
import type { Release } from "@decocms/shared/sdk/types";
import {
  addRelease,
  groupReleasesByRuntime,
  releaseRuntime,
  markReleaseSandbox,
  removeRelease,
  renameReleaseIn,
} from "./release-edits";

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

  it("markReleaseSandbox upgrades only the matching branch", () => {
    expect(
      markReleaseSandbox([{ ...rel("a"), runtime: "cms" }, rel("b")], "a"),
    ).toEqual([{ ...rel("a"), runtime: "sandbox" }, rel("b")]);
    expect(markReleaseSandbox([rel("a")], "a")).toEqual([
      { ...rel("a"), runtime: "sandbox" },
    ]);
  });

  it("markReleaseSandbox is a no-op for an unlisted or already-sandbox branch", () => {
    const current = [{ ...rel("a"), runtime: "sandbox" as const }];
    expect(markReleaseSandbox(current, "a")).toBe(current);
    expect(markReleaseSandbox(current, "b")).toBe(current);
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

describe("groupReleasesByRuntime", () => {
  const content = { ...rel("a"), runtime: "cms" as const };
  const unstamped = rel("b");
  const code = { ...rel("c"), runtime: "sandbox" as const };

  it("puts sandbox drafts in code and the rest in content, in list order", () => {
    expect(groupReleasesByRuntime([code, content, unstamped], "cms")).toEqual({
      content: [content, unstamped],
      code: [code],
    });
  });

  it("puts an unstamped draft in code on a project without Fast Preview", () => {
    expect(
      groupReleasesByRuntime([code, content, unstamped], "sandbox"),
    ).toEqual({
      content: [content],
      code: [code, unstamped],
    });
  });

  it("returns empty groups for an empty list", () => {
    expect(groupReleasesByRuntime([], "sandbox")).toEqual({
      content: [],
      code: [],
    });
  });
});

describe("releaseRuntime", () => {
  it("keeps a draft's own stamp whatever the project default", () => {
    expect(releaseRuntime({ ...rel("a"), runtime: "cms" }, "sandbox")).toBe(
      "cms",
    );
    expect(releaseRuntime({ ...rel("a"), runtime: "sandbox" }, "cms")).toBe(
      "sandbox",
    );
  });

  it("reads an unstamped draft as the project default", () => {
    expect(releaseRuntime(rel("a"), "cms")).toBe("cms");
    expect(releaseRuntime(rel("a"), "sandbox")).toBe("sandbox");
  });
});
