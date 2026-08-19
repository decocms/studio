import { describe, expect, it } from "bun:test";
import { buildMergeTreeEntries } from "./git-compat";

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
