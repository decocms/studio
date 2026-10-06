import { describe, expect, test } from "bun:test";
import type { OrgFsRecentEntry } from "@/hooks/use-org-fs";
import { curateRecents } from "./recents";

const entry = (volume: string, path: string): OrgFsRecentEntry => ({
  volume,
  path,
  kind: "file",
  size: 1,
  updatedAt: "2026-10-05T10:00:00.000Z",
});

describe("curateRecents", () => {
  test("keeps documents and media, drops agent state files", () => {
    const result = curateRecents(
      [
        entry("home", "briefs/today.md"),
        entry("home", "runs/t1/transcript.jsonl"),
        entry("home", "runs/t1/session-id"),
        entry("uploads", "photo.jpeg"),
      ],
      10,
    );
    expect(result.map((r) => r.entry.path)).toEqual([
      "briefs/today.md",
      "photo.jpeg",
    ]);
  });

  test("folds a burst in one folder into its newest file", () => {
    const result = curateRecents(
      [
        entry("home", "runs/out/c.txt"),
        entry("home", "runs/out/b.txt"),
        entry("home", "runs/out/a.txt"),
        entry("home", "decks/q3.html"),
      ],
      10,
    );
    expect(result).toEqual([
      { entry: entry("home", "runs/out/c.txt"), more: 2 },
      { entry: entry("home", "decks/q3.html"), more: 0 },
    ]);
  });

  test("treats the same folder name in two volumes as two folders", () => {
    const result = curateRecents(
      [entry("home", "a.md"), entry("outputs", "b.md")],
      10,
    );
    expect(result).toHaveLength(2);
  });

  test("caps at the limit after folding", () => {
    const result = curateRecents(
      [
        entry("home", "x/1.md"),
        entry("home", "y/2.md"),
        entry("home", "z/3.md"),
      ],
      2,
    );
    expect(result.map((r) => r.entry.path)).toEqual(["x/1.md", "y/2.md"]);
  });

  test("folds generated-id folders into the folder above them", () => {
    const result = curateRecents(
      [
        entry("uploads", "6a36530c-acd5-4c86-9e48-7654a6696aaa/image.png"),
        entry("uploads", "43e2ecfd-f565-4f58-b8e8-e29ac54c0bbb/image.png"),
      ],
      10,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.more).toBe(1);
  });
});
