/**
 * One listing, one shape.
 *
 * The Library used to render a folder and a file as two different kinds of
 * object — folders as a grid of cards, files as a table below it — so a folder
 * holding three subfolders and twenty files asked you to read two layouts and
 * compare across them. Every file manager worth copying puts them in ONE list
 * with folders on top, because "what is in here, and what changed" is a single
 * question.
 *
 * So each entry is normalized to the same record before anything renders it,
 * and the row and the tile are two presentations of that record rather than two
 * hierarchies. Pure, and exported for its test: a sort that silently drops an
 * entry loses someone's file.
 */

import type { OrgFsEntry } from "@/hooks/use-org-fs";
import { basename } from "./location";

/**
 * What an entry IS, which decides its mark and what opens it.
 *
 * `skill` and `brand` are folders the product understands — a dir carrying
 * `SKILL.md` or brand tokens — and they open their own preview rather than a
 * listing. That distinction is the server's (`hasSkill` / `hasBrand`), not a
 * name we pattern-match here.
 */
export type LibraryEntryKind = "folder" | "skill" | "brand" | "file";

export interface LibraryEntry {
  kind: LibraryEntryKind;
  /** In-volume path, unique within a listing. */
  path: string;
  name: string;
  updatedAt: string;
  size: number;
  entry: OrgFsEntry;
}

/** A dir carrying both markers is a skill: it is the more specific claim, and
 *  rendering it twice would put one folder in the list under two marks. */
function kindOf(entry: OrgFsEntry): LibraryEntryKind {
  if (entry.kind === "file") return "file";
  if (entry.hasSkill) return "skill";
  if (entry.hasBrand) return "brand";
  return "folder";
}

export function toLibraryEntry(entry: OrgFsEntry): LibraryEntry {
  return {
    kind: kindOf(entry),
    path: entry.path,
    name: basename(entry.path),
    updatedAt: entry.updatedAt,
    size: entry.size ?? 0,
    entry,
  };
}

export const LIBRARY_SORTS = ["name", "updated", "size"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

/** Folders group above files whatever the sort is. Sorting a listing by size
 *  and getting folders interleaved at zero bytes is the behaviour every file
 *  manager decided against: a folder's size is not a fact the listing knows. */
function group(entry: LibraryEntry): number {
  return entry.kind === "file" ? 1 : 0;
}

/**
 * The listing in display order.
 *
 * `name` is locale-aware and numeric, so `img2` precedes `img10` and `Ação`
 * files where a reader expects it. `updated` and `size` are descending —
 * newest and largest first is what someone asking for them wants — and both
 * fall back to name, so entries sharing a timestamp keep a stable order
 * instead of shuffling between renders.
 */
export function sortEntries(
  entries: readonly LibraryEntry[],
  sort: LibrarySort,
): LibraryEntry[] {
  const byName = (a: LibraryEntry, b: LibraryEntry) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  return [...entries].sort((a, b) => {
    const grouped = group(a) - group(b);
    if (grouped !== 0) return grouped;
    if (sort === "updated") {
      const diff = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      if (diff !== 0) return diff;
    }
    if (sort === "size") {
      const diff = b.size - a.size;
      if (diff !== 0) return diff;
    }
    return byName(a, b);
  });
}

/** `1.2 MB`. Bytes are never shown: nobody reading a listing wants them, and
 *  a folder has no size at all, which is why this returns null for one. */
export function formatSize(entry: LibraryEntry): string | null {
  if (entry.kind !== "file") return null;
  const bytes = entry.size;
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
