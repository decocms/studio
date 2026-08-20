import { describe, expect, it } from "bun:test";
import {
  buildMergeTreeEntries,
  buildPublishStatus,
  normalizeCompareStatus,
} from "./git-compat";

describe("buildMergeTreeEntries", () => {
  it("writes a rename as create-destination + delete-source", () => {
    const entries = buildMergeTreeEntries(
      [
        {
          filename: "Header.json",
          status: "renamed",
          sha: "b1",
          previousFilename: "Hero.json",
        },
      ],
      new Map([["Header.json", { sha: "b1" }]]),
    );
    expect(entries).toContainEqual({
      path: "Header.json",
      mode: "100644",
      type: "blob",
      sha: "b1",
    });
    expect(entries).toContainEqual({
      path: "Hero.json",
      mode: "100644",
      type: "blob",
      sha: null,
    });
  });

  it("keeps a path's new content when it is both a rename destination and another file's rename source, regardless of diff order", () => {
    const files = [
      {
        filename: "Header.json",
        status: "renamed",
        sha: "b1",
        previousFilename: "Hero.json",
      },
      {
        filename: "Hero.json",
        status: "renamed",
        sha: "b2",
        previousFilename: "Banner.json",
      },
    ];
    const branchBlobByPath = new Map([
      ["Header.json", { sha: "b1" }],
      ["Hero.json", { sha: "b2" }],
    ]);

    for (const ordered of [files, [...files].reverse()]) {
      const entries = buildMergeTreeEntries(ordered, branchBlobByPath);
      const heroEntry = entries.find((e) => e.path === "Hero.json");
      expect(heroEntry).toEqual({
        path: "Hero.json",
        mode: "100644",
        type: "blob",
        sha: "b2",
      });
      expect(entries).toContainEqual({
        path: "Banner.json",
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }
  });

  it("deletes a removed file", () => {
    const entries = buildMergeTreeEntries(
      [{ filename: "Old.json", status: "removed", sha: "b1" }],
      new Map(),
    );
    expect(entries).toEqual([
      { path: "Old.json", mode: "100644", type: "blob", sha: null },
    ]);
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
