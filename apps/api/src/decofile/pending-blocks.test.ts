import { describe, expect, it } from "bun:test";
import type { RepoContentClient } from "@/git-providers";
import type { DecofilePendingBlock } from "@/storage/types";
import {
  buildPublishStatus,
  withPendingDiff,
  withPendingStatus,
} from "./git-compat";
import {
  type PendingFile,
  pendingFileContent,
  pendingVersion,
} from "./pending-blocks";

const SHA = "a".repeat(40);

function block(
  blockKey: string,
  content: Record<string, unknown> | null,
  revision = "1",
): DecofilePendingBlock {
  return { blockKey, content, revision };
}

describe("pendingVersion", () => {
  it("is the head sha when nothing is pending", () => {
    expect(pendingVersion(SHA, [])).toBe(SHA);
  });

  it("fits the runtime's version charset and changes with each revision", () => {
    const one = pendingVersion(SHA, [block("pages-home", {}, "1")]);
    const two = pendingVersion(SHA, [block("pages-home", {}, "2")]);
    expect(one).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(one).not.toBe(two);
  });

  it("does not depend on row order", () => {
    const rows = [block("a", {}, "1"), block("b", null, "2")];
    expect(pendingVersion(SHA, rows)).toBe(
      pendingVersion(SHA, [...rows].reverse()),
    );
  });

  it("differs once a row is dropped, even back to an older set's max revision", () => {
    // {a:1, b:2} → a saved again {a:3, b:2} → a discarded {b:2}: a new state.
    const before = pendingVersion(SHA, [
      block("a", {}, "1"),
      block("b", {}, "2"),
    ]);
    const after = pendingVersion(SHA, [block("b", {}, "2")]);
    expect(after).not.toBe(before);
  });
});

describe("pendingFileContent", () => {
  it("is the file a commit would write, or null for a delete", () => {
    expect(pendingFileContent(block("home", { v: 1 }))).toBe(
      '{\n  "v": 1\n}\n',
    );
    expect(pendingFileContent(block("home", null))).toBeNull();
  });
});

function statusWith(files: Array<{ filename: string; status: string }>) {
  return buildPublishStatus({
    base: "main",
    branch: "draft",
    headSha: SHA,
    compared: { aheadBy: files.length, behindBy: 0, files },
  });
}

function file(
  path: string,
  content: Record<string, unknown> | null,
  existsAtHead: boolean,
): PendingFile {
  return { block: block(path, content), path, existsAtHead };
}

describe("withPendingStatus", () => {
  it("lists held saves as local changes and in the manifest", () => {
    const status = withPendingStatus(
      statusWith([]),
      [
        file(".deco/blocks/home.json", { v: 2 }, true),
        file(".deco/blocks/new.json", { v: 1 }, false),
        file(".deco/blocks/old.json", null, true),
      ],
      `${SHA}.0123456789abcdef`,
    );
    expect(status.modified).toEqual([".deco/blocks/home.json"]);
    expect(status.created).toEqual([".deco/blocks/new.json"]);
    expect(status.deleted).toEqual([".deco/blocks/old.json"]);
    expect(status.changedFiles).toEqual([
      { path: ".deco/blocks/home.json", status: "modified" },
      { path: ".deco/blocks/new.json", status: "added" },
      { path: ".deco/blocks/old.json", status: "removed" },
    ]);
    expect(status.changedFilesTotal).toBe(3);
    expect(status.headSha).toBe(`${SHA}.0123456789abcdef`);
  });

  it("folds with what the branch already committed against base", () => {
    const status = withPendingStatus(
      statusWith([
        { filename: ".deco/blocks/added.json", status: "added" },
        { filename: ".deco/blocks/dropped.json", status: "added" },
        { filename: ".deco/blocks/edited.json", status: "modified" },
      ]),
      [
        // Added on the branch, then edited: still new against base.
        file(".deco/blocks/added.json", { v: 2 }, true),
        // Added on the branch, then deleted: nothing differs from base.
        file(".deco/blocks/dropped.json", null, true),
        file(".deco/blocks/edited.json", { v: 3 }, true),
      ],
      `${SHA}.0123456789abcdef`,
    );
    expect(status.changedFiles).toEqual([
      { path: ".deco/blocks/added.json", status: "added" },
      { path: ".deco/blocks/edited.json", status: "modified" },
    ]);
    expect(status.changedFilesTotal).toBe(2);
  });

  it("is the status unchanged when nothing is pending", () => {
    const status = statusWith([]);
    expect(withPendingStatus(status, [], SHA)).toBe(status);
  });
});

describe("withPendingDiff", () => {
  const client = {
    readFileAtRef: async (_ref: string, path: string) =>
      path === ".deco/blocks/home.json" ? '{\n  "v": 1\n}\n' : null,
  } as unknown as RepoContentClient;

  it("takes the held content as the new side and base's copy as the old", async () => {
    const diff = await withPendingDiff(
      client,
      {
        diffs: {
          ".deco/blocks/edited.json": { from: "base", to: "committed" },
        },
        mergeBaseSha: "base-sha",
      },
      [
        file(".deco/blocks/home.json", { v: 2 }, true),
        file(".deco/blocks/edited.json", null, true),
      ],
    );
    expect(diff.diffs).toEqual({
      ".deco/blocks/home.json": {
        from: '{\n  "v": 1\n}\n',
        to: '{\n  "v": 2\n}\n',
      },
      ".deco/blocks/edited.json": { from: "base", to: null },
    });
  });

  it("drops a path whose held content is back to base's", async () => {
    const diff = await withPendingDiff(
      client,
      { diffs: {}, mergeBaseSha: "base-sha" },
      [file(".deco/blocks/home.json", { v: 1 }, true)],
    );
    expect(diff.diffs).toEqual({});
  });
});
