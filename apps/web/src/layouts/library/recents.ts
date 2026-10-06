/**
 * What "Recent" shows: files a person opens, newest first, one per folder.
 *
 * Agents write in bursts — a run drops a dozen scratch files in one folder in a
 * minute — so the newest file of each folder stands for the rest, with a count.
 * Only documents and media qualify: logs, transcripts and extensionless state
 * files are an agent's working memory, not something to open.
 */

import type { OrgFsRecentEntry } from "@/hooks/use-org-fs";
import { matchesLibraryFileView } from "./file-view";
import { namedFolderOf } from "./location";

export interface RecentFile {
  entry: OrgFsRecentEntry;
  /** Other recent files in the same folder, folded into this one. */
  more: number;
}

function folderKey(entry: OrgFsRecentEntry): string {
  return `${entry.volume}/${namedFolderOf(entry.path)}`;
}

/** `entries` must arrive newest first, as the recent feed returns them. */
export function curateRecents(
  entries: readonly OrgFsRecentEntry[],
  limit: number,
): RecentFile[] {
  const byFolder = new Map<string, RecentFile>();
  for (const entry of entries) {
    if (
      !matchesLibraryFileView(entry.path, "documents") &&
      !matchesLibraryFileView(entry.path, "media")
    ) {
      continue;
    }
    const key = folderKey(entry);
    const existing = byFolder.get(key);
    if (existing) existing.more += 1;
    else byFolder.set(key, { entry, more: 0 });
  }
  return [...byFolder.values()].slice(0, limit);
}
