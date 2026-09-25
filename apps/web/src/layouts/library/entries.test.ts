import { describe, expect, test } from "bun:test";
import type { OrgFsEntry } from "@/hooks/use-org-fs";
import { formatSize, sortEntries, toLibraryEntry } from "./entries";

function entry(over: Partial<OrgFsEntry> & { path: string }): OrgFsEntry {
  return { kind: "file", size: 0, updatedAt: "2026-09-01T00:00:00Z", ...over };
}

const at = (iso: string) => iso;

describe("toLibraryEntry", () => {
  test("reads the kind off the server's markers, never the name", () => {
    expect(toLibraryEntry(entry({ path: "a", kind: "dir" })).kind).toBe(
      "folder",
    );
    expect(
      toLibraryEntry(entry({ path: "a", kind: "dir", hasBrand: true })).kind,
    ).toBe("brand");
    expect(
      toLibraryEntry(entry({ path: "a", kind: "dir", hasSkill: true })).kind,
    ).toBe("skill");
  });

  /** One folder under two marks would be one folder listed twice. */
  test("a dir carrying both markers is a skill", () => {
    const both = entry({
      path: "a",
      kind: "dir",
      hasSkill: true,
      hasBrand: true,
    });
    expect(toLibraryEntry(both).kind).toBe("skill");
  });

  test("names an entry by its last segment", () => {
    expect(toLibraryEntry(entry({ path: "decks/q3/deck.pdf" })).name).toBe(
      "deck.pdf",
    );
  });
});

describe("sortEntries", () => {
  const entries = [
    toLibraryEntry(
      entry({
        path: "img10.png",
        size: 10,
        updatedAt: at("2026-09-03T00:00:00Z"),
      }),
    ),
    toLibraryEntry(
      entry({
        path: "img2.png",
        size: 900,
        updatedAt: at("2026-09-01T00:00:00Z"),
      }),
    ),
    toLibraryEntry(
      entry({
        path: "zeta",
        kind: "dir",
        updatedAt: at("2026-08-01T00:00:00Z"),
      }),
    ),
  ];

  test("folders lead every sort, including by size", () => {
    for (const sort of ["name", "updated", "size"] as const) {
      expect(sortEntries(entries, sort)[0]?.name).toBe("zeta");
    }
  });

  test("names sort numerically, so img2 precedes img10", () => {
    expect(sortEntries(entries, "name").map((e) => e.name)).toEqual([
      "zeta",
      "img2.png",
      "img10.png",
    ]);
  });

  test("updated is newest first", () => {
    expect(sortEntries(entries, "updated").map((e) => e.name)).toEqual([
      "zeta",
      "img10.png",
      "img2.png",
    ]);
  });

  test("size is largest first", () => {
    expect(sortEntries(entries, "size").map((e) => e.name)).toEqual([
      "zeta",
      "img2.png",
      "img10.png",
    ]);
  });

  /** Entries sharing a timestamp must not shuffle between renders. */
  test("ties fall back to name", () => {
    const tied = [
      toLibraryEntry(entry({ path: "b.txt" })),
      toLibraryEntry(entry({ path: "a.txt" })),
    ];
    expect(sortEntries(tied, "updated").map((e) => e.name)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  test("drops nothing", () => {
    expect(sortEntries(entries, "name")).toHaveLength(entries.length);
  });
});

describe("formatSize", () => {
  test("a folder has no size the listing knows", () => {
    expect(formatSize(toLibraryEntry(entry({ path: "a", kind: "dir" })))).toBe(
      null,
    );
  });

  test("scales to the unit that reads", () => {
    expect(formatSize(toLibraryEntry(entry({ path: "a", size: 900 })))).toBe(
      "900 B",
    );
    expect(formatSize(toLibraryEntry(entry({ path: "a", size: 1536 })))).toBe(
      "1.5 KB",
    );
    expect(
      formatSize(toLibraryEntry(entry({ path: "a", size: 20 * 1024 * 1024 }))),
    ).toBe("20 MB");
  });

  test("an empty file shows nothing rather than a zero", () => {
    expect(formatSize(toLibraryEntry(entry({ path: "a", size: 0 })))).toBe(
      null,
    );
  });
});
