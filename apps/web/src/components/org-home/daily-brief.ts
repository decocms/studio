/** Which daily briefs the home shows, in the order it shows them. The paths
 *  and the date rule come from `@decocms/shared/daily-brief`. */

import {
  briefAgeDays,
  briefPath,
  ORG_BRIEF_DIR,
  personalBriefDir,
  pickBrief,
} from "@decocms/shared/daily-brief";

export type BriefScope = "personal" | "org";

export interface ShownBrief {
  scope: BriefScope;
  /** Path in the `home` volume. */
  path: string;
  filename: string;
  size: number;
  day: string;
  ageDays: number;
}

interface ListedEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function shown(
  scope: BriefScope,
  dir: string,
  entries: ListedEntry[],
  today: string,
): ShownBrief | null {
  const files = entries.filter((e) => e.kind === "file");
  const pick = pickBrief(
    files.map((e) => basename(e.path)),
    today,
  );
  const entry = pick && files.find((e) => basename(e.path) === pick.name);
  return pick && entry
    ? {
        scope,
        path: briefPath(dir, pick.day),
        filename: pick.name,
        size: entry.size,
        day: pick.day,
        ageDays: briefAgeDays(pick.day, today),
      }
    : null;
}

/** The member's own brief first, then the org's; empty when neither folder
 *  holds a brief for today or earlier. */
export function briefsToShow({
  userId,
  personal,
  org,
  today,
}: {
  userId: string | undefined;
  personal: ListedEntry[];
  org: ListedEntry[];
  today: string;
}): ShownBrief[] {
  return [
    userId
      ? shown("personal", personalBriefDir(userId), personal, today)
      : null,
    shown("org", ORG_BRIEF_DIR, org, today),
  ].filter((b): b is ShownBrief => b !== null);
}
