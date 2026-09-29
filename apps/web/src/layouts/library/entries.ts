/**
 * One listing, one shape: folders and files normalized to the same record, so
 * the row and the tile are two presentations rather than two hierarchies.
 * Pure and tested — a sort that drops an entry loses someone's file.
 */

import type { OrgFsEntry } from "@/hooks/use-org-fs";
import { basename } from "./location";

/** What an entry IS, which decides its mark and what opens it. `skill` and
 *  `brand` are the server's claim (`hasSkill`/`hasBrand`), not a name match. */
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

/** Both markers means skill — the more specific claim. */
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

/** Folders group above files whatever the sort is: a folder's size is not a
 *  fact the listing knows. */
function group(entry: LibraryEntry): number {
  return entry.kind === "file" ? 1 : 0;
}

/** `name` is locale-aware and numeric (`img2` before `img10`). `updated` and
 *  `size` are descending and fall back to name, so ties stay stable. */
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

/** `1.2 MB`; null for a folder, which has no size. */
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
