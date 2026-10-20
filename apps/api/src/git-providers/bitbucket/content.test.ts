import { describe, expect, test } from "bun:test";
import {
  branchAuthor,
  buildCommitForm,
  isBranchExistsConflict,
  isCommitConflict,
  mapDiffstatEntry,
  mapPullRequest,
  mapPullRequestState,
  mapSrcEntry,
  parseTreeSha,
  treeSha,
} from "./content";

describe("treeSha / parseTreeSha", () => {
  test("round-trips, including a path with a colon in it", () => {
    const sha = treeSha("abc123", ".deco/blocks/site:home.json");
    expect(sha).toBe("abc123:.deco/blocks/site:home.json");
    expect(parseTreeSha(sha)).toEqual({
      commit: "abc123",
      path: ".deco/blocks/site:home.json",
    });
  });
  test("refuses a sha that is not of the synthetic form", () => {
    expect(() => parseTreeSha("abc123")).toThrow(/<commit>:<path>/);
    expect(() => parseTreeSha(":path")).toThrow(/<commit>:<path>/);
    expect(() => parseTreeSha("abc:")).toThrow(/<commit>:<path>/);
  });
});

describe("mapSrcEntry", () => {
  test("a file carries its size and pins the listed commit", () => {
    expect(
      mapSrcEntry(
        {
          type: "commit_file",
          path: ".deco/blocks/a.json",
          size: 42,
          commit: { hash: "c1" },
        },
        "main",
      ),
    ).toEqual({
      path: ".deco/blocks/a.json",
      sha: "c1:.deco/blocks/a.json",
      type: "blob",
      size: 42,
    });
  });
  test("a directory is a tree without a size", () => {
    expect(
      mapSrcEntry({ type: "commit_directory", path: ".deco/blocks" }, "c1"),
    ).toEqual({ path: ".deco/blocks", sha: "c1:.deco/blocks", type: "tree" });
  });
  test("anything else is dropped", () => {
    expect(mapSrcEntry({ type: "submodule", path: "vendor" }, "c1")).toBeNull();
    expect(mapSrcEntry({ type: "commit_file" }, "c1")).toBeNull();
  });
});

describe("buildCommitForm", () => {
  const exists = (present: string[]) => (path: string) =>
    present.includes(path);

  test("writes are fields named by path; deletes go under files", () => {
    const form = buildCommitForm({
      branch: "main",
      parent: "p1",
      message: "save",
      changes: [
        { path: "a.json", content: "A" },
        { path: "b.json", deleted: true },
      ],
      existsAtParent: exists(["b.json"]),
    });
    expect(form).not.toBeNull();
    expect(form!.get("a.json")).toBe("A");
    expect(form!.getAll("files")).toEqual(["b.json"]);
    expect(form!.get("message")).toBe("save");
    expect(form!.get("branch")).toBe("main");
    expect(form!.get("parents")).toBe("p1");
  });

  test("deleting a path that is not there is dropped, not sent", () => {
    const form = buildCommitForm({
      branch: "main",
      parent: "p1",
      message: "save",
      changes: [
        { path: "gone.json", deleted: true },
        { path: "a.json", content: "A" },
      ],
      existsAtParent: exists([]),
    });
    expect(form!.getAll("files")).toEqual([]);
    expect(form!.get("a.json")).toBe("A");
  });

  test("two changes to one path collapse to the last", () => {
    const form = buildCommitForm({
      branch: "main",
      parent: "p1",
      message: "save",
      changes: [
        { path: "a.json", content: "first" },
        { path: "a.json", content: "second" },
      ],
      existsAtParent: exists([]),
    });
    expect(form!.getAll("a.json")).toEqual(["second"]);
  });

  test("nothing to commit yields no form", () => {
    expect(
      buildCommitForm({
        branch: "main",
        parent: "p1",
        message: "save",
        changes: [{ path: "gone.json", deleted: true }],
        existsAtParent: exists([]),
      }),
    ).toBeNull();
    expect(
      buildCommitForm({
        branch: "main",
        parent: "p1",
        message: "save",
        changes: [],
        existsAtParent: exists([]),
      }),
    ).toBeNull();
  });
});

describe("isCommitConflict", () => {
  test("a parents guard that no longer names the tip", () => {
    expect(isCommitConflict(400, "parents is not the tip of branch")).toBe(
      true,
    );
    expect(isCommitConflict(409, "The branch has moved: conflict")).toBe(true);
  });
  test("other 400s are not conflicts", () => {
    expect(isCommitConflict(400, "message is required")).toBe(false);
  });
  test("other statuses are never conflicts, whatever the message says", () => {
    expect(isCommitConflict(403, "conflict")).toBe(false);
    expect(isCommitConflict(500, "tip")).toBe(false);
  });
});

describe("isBranchExistsConflict", () => {
  test("400 with the branch-exists prose", () => {
    expect(
      isBranchExistsConflict(400, "A branch with the name 'x' already exists"),
    ).toBe(true);
    expect(isBranchExistsConflict(400, "BRANCH_ALREADY_EXISTS")).toBe(true);
  });
  test("a 400 for anything else is a plain failure", () => {
    expect(isBranchExistsConflict(400, "target is required")).toBe(false);
  });
  test("a 403 on a protected branch is not a conflict", () => {
    expect(isBranchExistsConflict(403, "already exists")).toBe(false);
  });
});

describe("mapPullRequestState / mapPullRequest", () => {
  test("OPEN and MERGED pass through; everything else is closed", () => {
    expect(mapPullRequestState("OPEN")).toBe("open");
    expect(mapPullRequestState("MERGED")).toBe("merged");
    expect(mapPullRequestState("DECLINED")).toBe("closed");
    expect(mapPullRequestState("SUPERSEDED")).toBe("closed");
    expect(mapPullRequestState(undefined)).toBe("closed");
  });
  test("id is the number and the html link is the url", () => {
    expect(
      mapPullRequest({
        id: 12,
        title: "Ship",
        state: "OPEN",
        links: { html: { href: "https://bitbucket.org/a/s/pull-requests/12" } },
      }),
    ).toEqual({
      number: 12,
      url: "https://bitbucket.org/a/s/pull-requests/12",
      title: "Ship",
      state: "open",
    });
  });
});

describe("mapDiffstatEntry", () => {
  test("a surviving file gets the synthetic sha at head", () => {
    expect(
      mapDiffstatEntry(
        { status: "modified", old: { path: "a.ts" }, new: { path: "a.ts" } },
        "h1",
      ),
    ).toEqual({ filename: "a.ts", status: "modified", sha: "h1:a.ts" });
  });
  test("a removed file keeps an empty sha", () => {
    expect(
      mapDiffstatEntry({ status: "removed", old: { path: "a.ts" } }, "h1"),
    ).toEqual({ filename: "a.ts", status: "removed", sha: "" });
  });
  test("a rename carries the previous filename", () => {
    expect(
      mapDiffstatEntry(
        { status: "renamed", old: { path: "old.ts" }, new: { path: "new.ts" } },
        "h1",
      ),
    ).toEqual({
      filename: "new.ts",
      status: "renamed",
      sha: "h1:new.ts",
      previousFilename: "old.ts",
    });
  });
  test("an entry with no path is dropped", () => {
    expect(mapDiffstatEntry({ status: "modified" }, "h1")).toBeNull();
  });
});

describe("branchAuthor", () => {
  test("prefers the resolved account, then the raw name", () => {
    expect(
      branchAuthor({
        target: { author: { user: { nickname: "viktor" }, raw: "V <v@x>" } },
      }),
    ).toBe("viktor");
    expect(
      branchAuthor({ target: { author: { raw: "Ada Lovelace <ada@x.io>" } } }),
    ).toBe("Ada Lovelace");
  });
  test("null when nothing is known", () => {
    expect(branchAuthor({})).toBeNull();
    expect(branchAuthor({ target: { author: { raw: "  " } } })).toBeNull();
  });
});
