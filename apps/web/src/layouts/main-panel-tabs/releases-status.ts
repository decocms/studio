/**
 * What each row of the Releases screen says, as pure functions: its title in
 * business words, its pill and whether it offers "Make current".
 *
 * "Latest" is the version latest.json names: the newest one Publish (or a
 * reapply) put on the CDN. It says nothing about what a visitor's page
 * shows at this second; the screen never claims that.
 */

import type { TFunction } from "@/i18n/use-t.ts";
import type { ReleaseCommit, ReleasePointer } from "./releases-api";

/** Whether the row for commit `sha` is the latest version. */
export function isLatest(sha: string, current: ReleasePointer | null): boolean {
  return current !== null && sha === current.revision;
}

/** The sha latest.json names on a releases page, or null. */
export function latestSha(
  page: { current: ReleasePointer | null } | undefined,
): string | null {
  if (!page) return null;
  const { current } = page;
  return current ? current.revision : null;
}

/** Whether a row offers "Make current": an earlier release that was released. */
/**
 * Whether a version can be opened in the preview ("Preview this version"):
 * any one with a companion release, the latest included. The site reads that
 * release by its commit SHA from a Studio link only.
 */
export function canPreviewRelease(
  commit: Pick<ReleaseCommit, "sha" | "hasRelease">,
): boolean {
  return commit.hasRelease && /^[0-9a-f]{40}$/.test(commit.sha);
}

export function canReapply(
  commit: Pick<ReleaseCommit, "sha" | "hasRelease">,
  current: ReleasePointer | null,
): boolean {
  return commit.hasRelease && !isLatest(commit.sha, current);
}

const REAPPLY_PREFIX = "Reapply: ";
/** The server's dated note: "release from …" (older notes: "version from …"). */
const REAPPLY_OF_DATE =
  /^(?:release|version) from (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/;
/** The server's note when even the date was unreadable (old and new words). */
const REAPPLY_OF_UNKNOWN = new Set(["earlier release", "earlier version"]);
/** Publish's title when there was no note: developer words, never shown. */
const NO_NOTE = /^chore\(decofile\):/;

/** A commit message's title line: the note a Publish wrote. */
export const titleLine = (message: string) =>
  message.split("\n")[0]?.trim() ?? "";

/** A date and time in the viewer's language. */
export function formatWhen(date: Date, language: string): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** A version's note in business words (a reapply is localized). */
export function releaseTitle(
  t: TFunction,
  commit: Pick<ReleaseCommit, "message" | "hasRelease">,
  language: string,
): string {
  if (!commit.hasRelease) return t("releases.siteUpdate");
  const title = titleLine(commit.message);
  if (title.startsWith(REAPPLY_PREFIX)) {
    const rest = title.slice(REAPPLY_PREFIX.length).trim();
    const dated = rest.match(REAPPLY_OF_DATE);
    if (dated) {
      const when = new Date(`${dated[1]}T${dated[2]}:00Z`);
      if (!Number.isNaN(when.getTime())) {
        return t("releases.reapplyOfDate", {
          when: formatWhen(when, language),
        });
      }
    }
    if (!rest || REAPPLY_OF_UNKNOWN.has(rest) || NO_NOTE.test(rest)) {
      return t("releases.reapplyOf", { title: t("releases.untitled") });
    }
    return t("releases.reapplyOf", { title: rest });
  }
  if (!title || NO_NOTE.test(title)) return t("releases.untitled");
  return title;
}
