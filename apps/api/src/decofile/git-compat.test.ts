import { describe, expect, it } from "bun:test";
import type { TreeEntry } from "@/git-providers/content/types";
import {
  buildDiscardPlan,
  buildMergeReplayPlan,
  buildPublishStatus,
  normalizeCompareStatus,
} from "./git-compat";

describe("buildMergeReplayPlan", () => {
  it("writes a rename as create-destination + delete-source", () => {
    const plan = buildMergeReplayPlan(
      [
        {
          filename: "Header.json",
          status: "renamed",
          previousFilename: "Hero.json",
        },
      ],
      "merged-sha",
    );
    expect(plan).toContainEqual({
      path: "Header.json",
      copyFromRef: "merged-sha",
    });
    expect(plan).toContainEqual({ path: "Hero.json", deleted: true });
  });

  it("keeps a path's new content when it is both a rename destination and another file's rename source, regardless of diff order", () => {
    const files = [
      {
        filename: "Header.json",
        status: "renamed",
        previousFilename: "Hero.json",
      },
      {
        filename: "Hero.json",
        status: "renamed",
        previousFilename: "Banner.json",
      },
    ];

    for (const ordered of [files, [...files].reverse()]) {
      const plan = buildMergeReplayPlan(ordered, "merged-sha");
      expect(plan.find((e) => e.path === "Hero.json")).toEqual({
        path: "Hero.json",
        copyFromRef: "merged-sha",
      });
      expect(plan).toContainEqual({ path: "Banner.json", deleted: true });
    }
  });

  it("deletes a removed file rather than replaying it from the source ref", () => {
    const plan = buildMergeReplayPlan(
      [{ filename: "Old.json", status: "removed" }],
      "merged-sha",
    );
    expect(plan).toEqual([{ path: "Old.json", deleted: true }]);
  });

  it("replays every surviving path from the one source ref, uploading nothing", () => {
    const plan = buildMergeReplayPlan(
      [
        { filename: "A.json", status: "modified" },
        { filename: "B.json", status: "added" },
      ],
      "branch-head",
    );
    expect(plan).toEqual([
      { path: "A.json", copyFromRef: "branch-head" },
      { path: "B.json", copyFromRef: "branch-head" },
    ]);
  });
});

describe("buildDiscardPlan", () => {
  const blob = (sha: string): TreeEntry => ({
    path: "irrelevant", // overwritten by the map key at lookup time
    type: "blob",
    sha,
  });

  it("restores the path from the base ref itself, so an executable stays executable", () => {
    const plan = buildDiscardPlan(
      ["run.sh"],
      new Map([["run.sh", blob("base-sha")]]),
      new Map([["run.sh", blob("head-sha")]]),
      "merge-base",
    );
    expect(plan).toEqual([{ path: "run.sh", copyFromRef: "merge-base" }]);
  });

  it("deletes a path the base doesn't have", () => {
    const plan = buildDiscardPlan(
      ["New.json"],
      new Map(),
      new Map([["New.json", blob("head-sha")]]),
      "merge-base",
    );
    expect(plan).toEqual([{ path: "New.json", deleted: true }]);
  });

  it("is a no-op when base and head already match, or both are absent", () => {
    const plan = buildDiscardPlan(
      ["Same.json", "Never.json"],
      new Map([["Same.json", blob("s")]]),
      new Map([["Same.json", blob("s")]]),
      "merge-base",
    );
    expect(plan).toEqual([]);
  });
});

describe("normalizeCompareStatus", () => {
  it("maps GitHub's full compare vocabulary onto the three drawable states", () => {
    expect(normalizeCompareStatus("added")).toBe("added");
    expect(normalizeCompareStatus("copied")).toBe("added");
    expect(normalizeCompareStatus("removed")).toBe("removed");
    expect(normalizeCompareStatus("renamed")).toBe("renamed");
    expect(normalizeCompareStatus("modified")).toBe("modified");
    expect(normalizeCompareStatus("changed")).toBe("modified");
    expect(normalizeCompareStatus("unchanged")).toBe("modified");
  });

  it("folds an unknown status into modified rather than leaking it", () => {
    expect(normalizeCompareStatus("something-new")).toBe("modified");
  });
});

describe("buildPublishStatus", () => {
  const compared = (
    files: Array<{
      filename: string;
      status: string;
      previousFilename?: string;
    }>,
  ) => ({
    aheadBy: 2,
    behindBy: 0,
    files,
  });

  it("carries the changed-path manifest with a rename's source path", () => {
    const status = buildPublishStatus({
      base: "main",
      branch: "feat",
      headSha: "h1",
      compared: compared([
        { filename: ".deco/blocks/Home.json", status: "modified" },
        {
          filename: ".deco/blocks/Header.json",
          status: "renamed",
          previousFilename: ".deco/blocks/Hero.json",
        },
      ]),
    });
    expect(status.changedFiles).toEqual([
      { path: ".deco/blocks/Home.json", status: "modified" },
      {
        path: ".deco/blocks/Header.json",
        status: "renamed",
        previousPath: ".deco/blocks/Hero.json",
      },
    ]);
    expect(status.changedFilesTruncated).toBe(false);
    expect(status.aheadOfBase).toBe(2);
    expect(status.headSha).toBe("h1");
  });

  it("reports the PRE-cap total while capping the manifest itself", () => {
    const files = Array.from({ length: 240 }, (_, i) => ({
      filename: `.deco/blocks/Block${i}.json`,
      status: "added",
    }));
    const status = buildPublishStatus({
      base: "main",
      branch: "feat",
      headSha: "h1",
      compared: compared(files),
    });
    expect(status.changedFiles).toHaveLength(200);
    expect(status.changedFilesTotal).toBe(240);
    expect(status.changedFilesTruncated).toBe(true);
  });

  it("reports an empty, untruncated manifest when nothing changed", () => {
    const status = buildPublishStatus({
      base: "main",
      branch: "main",
      headSha: "h1",
      compared: { aheadBy: 0, behindBy: 0, files: [] },
    });
    expect(status.changedFiles).toEqual([]);
    expect(status.changedFilesTotal).toBe(0);
    expect(status.changedFilesTruncated).toBe(false);
  });

  it("keeps every local-work field empty — sandbox-less mode has no working tree", () => {
    const status = buildPublishStatus({
      base: "main",
      branch: "feat",
      headSha: "h1",
      compared: compared([{ filename: "a.json", status: "added" }]),
    });
    expect(status.modified).toEqual([]);
    expect(status.staged).toEqual([]);
    expect(status.files).toEqual([]);
    expect(status.unpushed).toBe(0);
  });
});
