import { describe, expect, test } from "bun:test";
import {
  isProtectedBranch,
  buildCommitActions,
  decoDirFor,
  directoryOf,
  groupPathsByDirectory,
  isBranchExistsConflict,
  isCommitConflict,
  mapCompareDiff,
  mapMergeRequest,
  mapMergeRequestState,
  pooledMap,
  type ResolvedChange,
} from "./gitlab";
import { gitlabErrorMessage } from "../gitlab/http";

describe("buildCommitActions", () => {
  test("an existing file is an update guarded by its last commit", () => {
    const changes: ResolvedChange[] = [{ path: "a.json", content: "{}" }];
    expect(buildCommitActions(changes, new Map([["a.json", "c1"]]))).toEqual([
      {
        action: "update",
        file_path: "a.json",
        content: "{}",
        last_commit_id: "c1",
      },
    ]);
  });

  test("an absent file is an unguarded create", () => {
    const changes: ResolvedChange[] = [{ path: "new.json", content: "1" }];
    expect(buildCommitActions(changes, new Map())).toEqual([
      { action: "create", file_path: "new.json", content: "1" },
    ]);
    expect(buildCommitActions(changes, new Map([["new.json", null]]))).toEqual([
      { action: "create", file_path: "new.json", content: "1" },
    ]);
  });

  test("a delete carries the guard and never the content field", () => {
    const actions = buildCommitActions(
      [{ path: "gone.json", deleted: true }],
      new Map([["gone.json", "c9"]]),
    );
    expect(actions).toEqual([
      { action: "delete", file_path: "gone.json", last_commit_id: "c9" },
    ]);
    expect(actions[0]).not.toHaveProperty("content");
  });

  test("deleting a path that is not there is dropped, not sent", () => {
    expect(
      buildCommitActions([{ path: "never.json", deleted: true }], new Map()),
    ).toEqual([]);
    expect(
      buildCommitActions(
        [
          { path: "never.json", deleted: true },
          { path: "here.json", deleted: true },
        ],
        new Map([["here.json", "c2"]]),
      ),
    ).toEqual([
      { action: "delete", file_path: "here.json", last_commit_id: "c2" },
    ]);
  });

  test("mixed batch keeps input order and maps each action independently", () => {
    const actions = buildCommitActions(
      [
        { path: "keep.json", content: "k" },
        { path: "drop.json", deleted: true },
        { path: "add.json", content: "a" },
      ],
      new Map([
        ["keep.json", "c1"],
        ["drop.json", "c2"],
      ]),
    );
    expect(actions.map((a) => [a.action, a.file_path])).toEqual([
      ["update", "keep.json"],
      ["delete", "drop.json"],
      ["create", "add.json"],
    ]);
  });

  test("two changes to one path collapse to the last, in the first's slot", () => {
    const actions = buildCommitActions(
      [
        { path: "a.json", content: "first" },
        { path: "b.json", content: "b" },
        { path: "a.json", deleted: true },
      ],
      new Map([
        ["a.json", "c1"],
        ["b.json", "c2"],
      ]),
    );
    expect(actions).toEqual([
      { action: "delete", file_path: "a.json", last_commit_id: "c1" },
      {
        action: "update",
        file_path: "b.json",
        content: "b",
        last_commit_id: "c2",
      },
    ]);
  });

  test("no changes and no-op deletes both yield an empty action array", () => {
    expect(buildCommitActions([], new Map())).toEqual([]);
  });

  test("an executable file asks for the exec bit, on a create and on an update", () => {
    expect(
      buildCommitActions(
        [
          { path: "new.sh", content: "#!/bin/sh\n", mode: "100755" },
          { path: "old.sh", content: "#!/bin/sh\n", mode: "100755" },
        ],
        new Map([["old.sh", "c1"]]),
      ),
    ).toEqual([
      {
        action: "create",
        file_path: "new.sh",
        content: "#!/bin/sh\n",
        execute_filemode: true,
      },
      {
        action: "update",
        file_path: "old.sh",
        content: "#!/bin/sh\n",
        execute_filemode: true,
        last_commit_id: "c1",
      },
    ]);
  });

  test("a regular file clears the exec bit, and a change without a mode never mentions it", () => {
    const [stated, silent] = buildCommitActions(
      [
        { path: "plain.json", content: "{}", mode: "100644" },
        { path: "whatever.json", content: "{}" },
      ],
      new Map(),
    );
    expect(stated?.execute_filemode).toBe(false);
    expect(silent).not.toHaveProperty("execute_filemode");
  });
});

describe("isCommitConflict", () => {
  test("the per-file guard firing is a conflict", () => {
    expect(
      isCommitConflict(
        400,
        "GitLab API 400: The file has changed since you started editing it: .deco/blocks/page.json",
      ),
    ).toBe(true);
  });

  test("a create that lost the race is a conflict", () => {
    expect(isCommitConflict(400, "A file with this name already exists")).toBe(
      true,
    );
  });

  test("an update whose file vanished is a conflict", () => {
    expect(isCommitConflict(400, "A file with this name doesn't exist")).toBe(
      true,
    );
  });

  test("other 400s are not conflicts", () => {
    expect(isCommitConflict(400, "invalid parameters")).toBe(false);
    expect(
      isCommitConflict(
        400,
        "You can only create or edit files when you are on a branch",
      ),
    ).toBe(false);
  });

  test("other statuses are never conflicts, whatever the message says", () => {
    expect(
      isCommitConflict(
        403,
        "The file has changed since you started editing it",
      ),
    ).toBe(false);
    expect(isCommitConflict(500, "already exists")).toBe(false);
    expect(
      isCommitConflict(0, "The file has changed since you started editing it"),
    ).toBe(false);
  });
});

describe("isBranchExistsConflict", () => {
  test("400 Branch already exists", () => {
    expect(isBranchExistsConflict(400, "Branch already exists")).toBe(true);
  });
  test("a 400 for anything else is a plain failure", () => {
    expect(isBranchExistsConflict(400, "Invalid reference name: nope")).toBe(
      false,
    );
  });
  test("a 403 on a protected branch is not a conflict", () => {
    expect(isBranchExistsConflict(403, "already exists")).toBe(false);
  });
});

describe("mapMergeRequestState", () => {
  test("opened is the interface's open", () => {
    expect(mapMergeRequestState("opened")).toBe("open");
  });
  test("merged passes through", () => {
    expect(mapMergeRequestState("merged")).toBe("merged");
  });
  test("closed and locked are both closed", () => {
    expect(mapMergeRequestState("closed")).toBe("closed");
    expect(mapMergeRequestState("locked")).toBe("closed");
  });
  test("an unknown or missing state is closed, never open", () => {
    expect(mapMergeRequestState("something_new")).toBe("closed");
    expect(mapMergeRequestState(null)).toBe("closed");
    expect(mapMergeRequestState(undefined)).toBe("closed");
  });
});

describe("mapMergeRequest", () => {
  test("iid is the number and web_url is the url", () => {
    expect(
      mapMergeRequest({
        iid: 7,
        web_url: "https://gitlab.com/group/project/-/merge_requests/7",
        title: "Publish",
        state: "opened",
      }),
    ).toEqual({
      number: 7,
      url: "https://gitlab.com/group/project/-/merge_requests/7",
      title: "Publish",
      state: "open",
    });
  });

  test("a payload missing the optional strings still maps", () => {
    expect(mapMergeRequest({ iid: 1 })).toEqual({
      number: 1,
      url: "",
      title: "",
      state: "closed",
    });
  });
});

describe("directoryOf", () => {
  test("a nested path", () => {
    expect(directoryOf(".deco/blocks/page.json")).toBe(".deco/blocks");
  });
  test("a root file has the empty directory", () => {
    expect(directoryOf("README.md")).toBe("");
  });
  test("a leading slash addresses the same file", () => {
    expect(directoryOf("/src/app.ts")).toBe("src");
  });
});

describe("groupPathsByDirectory", () => {
  test("siblings share one bucket", () => {
    expect(
      groupPathsByDirectory([
        ".deco/blocks/a.json",
        ".deco/blocks/b.json",
        "apps/site/.deco/blocks/c.json",
      ]),
    ).toEqual(
      new Map([
        [".deco/blocks", [".deco/blocks/a.json", ".deco/blocks/b.json"]],
        ["apps/site/.deco/blocks", ["apps/site/.deco/blocks/c.json"]],
      ]),
    );
  });

  test("duplicates are listed once", () => {
    expect(groupPathsByDirectory(["a/b.json", "a/b.json"])).toEqual(
      new Map([["a", ["a/b.json"]]]),
    );
  });

  test("root files bucket under the empty directory", () => {
    expect(groupPathsByDirectory(["deno.json", "a/b.json"])).toEqual(
      new Map([
        ["", ["deno.json"]],
        ["a", ["a/b.json"]],
      ]),
    );
  });

  test("empty and slash-only input yields no buckets", () => {
    expect(groupPathsByDirectory([])).toEqual(new Map());
    expect(groupPathsByDirectory(["", "/"])).toEqual(new Map());
  });
});

describe("decoDirFor", () => {
  test("a repo-root project", () => {
    expect(decoDirFor(null)).toBe(".deco");
  });
  test("a nested project", () => {
    expect(decoDirFor("apps/site")).toBe("apps/site/.deco");
  });
});

describe("mapCompareDiff", () => {
  const shas = new Map([["a.json", "sha-a"]]);

  test("new_file is added and picks up the head sha", () => {
    expect(
      mapCompareDiff({ new_path: "a.json", new_file: true }, shas),
    ).toEqual({ filename: "a.json", status: "added", sha: "sha-a" });
  });

  test("deleted_file is removed and has no sha at head", () => {
    expect(
      mapCompareDiff(
        { new_path: "gone.json", old_path: "gone.json", deleted_file: true },
        shas,
      ),
    ).toEqual({ filename: "gone.json", status: "removed", sha: "" });
  });

  test("renamed_file carries previousFilename", () => {
    expect(
      mapCompareDiff(
        { new_path: "a.json", old_path: "old.json", renamed_file: true },
        shas,
      ),
    ).toEqual({
      filename: "a.json",
      status: "renamed",
      sha: "sha-a",
      previousFilename: "old.json",
    });
  });

  test("no flag set is a modification and never sets previousFilename", () => {
    const mapped = mapCompareDiff(
      { new_path: "a.json", old_path: "a.json" },
      shas,
    );
    expect(mapped).toEqual({
      filename: "a.json",
      status: "modified",
      sha: "sha-a",
    });
    expect(mapped).not.toHaveProperty("previousFilename");
  });

  test("an unresolved path degrades to an empty sha, not undefined", () => {
    expect(mapCompareDiff({ new_path: "other.json" }, shas).sha).toBe("");
  });
});

describe("gitlabErrorMessage", () => {
  test("the common string form", () => {
    expect(
      gitlabErrorMessage(
        '{"message":"The file has changed since you started editing it: a.json"}',
      ),
    ).toBe("The file has changed since you started editing it: a.json");
  });

  test("the merge-request array form, so the classifier still sees the text", () => {
    expect(
      gitlabErrorMessage(
        '{"message":["Another open merge request already exists for this source branch: !3"]}',
      ),
    ).toBe(
      "Another open merge request already exists for this source branch: !3",
    );
  });

  test("the validation-object form is flattened", () => {
    expect(
      gitlabErrorMessage('{"message":{"base":["Branch already exists"]}}'),
    ).toBe("Branch already exists");
  });

  test("the error form", () => {
    expect(gitlabErrorMessage('{"error":"insufficient_scope"}')).toBe(
      "insufficient_scope",
    );
  });

  test("a non-JSON body is truncated raw", () => {
    expect(gitlabErrorMessage("<html>502 Bad Gateway</html>")).toBe(
      "<html>502 Bad Gateway</html>",
    );
    expect(gitlabErrorMessage("x".repeat(500))).toHaveLength(300);
  });

  test("JSON without a usable message falls back to the body", () => {
    expect(gitlabErrorMessage('{"other":1}')).toBe('{"other":1}');
    expect(gitlabErrorMessage('{"message":[]}')).toBe('{"message":[]}');
  });
});

describe("pooledMap", () => {
  test("results keep the input order regardless of completion order", async () => {
    const out = await pooledMap([3, 1, 2], 2, async (n) => {
      await Promise.resolve();
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await pooledMap(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        return n;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  test("an empty input runs nothing", async () => {
    let calls = 0;
    expect(
      await pooledMap([], 4, async () => {
        calls++;
        return 1;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("isProtectedBranch", () => {
  /** The one rewrite failure with a slower answer rather than a fatal one:
   *  a forced push is refused, so the branch has to be replaced instead. */
  test("recognises GitLab's forced-push refusal", () => {
    expect(
      isProtectedBranch(
        "You are not allowed to force push code to a protected branch on this project.",
      ),
    ).toBe(true);
    expect(isProtectedBranch("protected branch")).toBe(true);
  });

  test("does not swallow an unrelated failure", () => {
    expect(isProtectedBranch("A branch called 'main' already exists.")).toBe(
      false,
    );
    expect(
      isProtectedBranch("The file has changed since you started editing it: a"),
    ).toBe(false);
    expect(isProtectedBranch("404 Project Not Found")).toBe(false);
  });
});
