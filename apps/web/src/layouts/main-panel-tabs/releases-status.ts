/**
 * What each row of the Releases screen says, as pure functions: its title in
 * business words, its pill and whether it offers "Make current".
 *
 * "Latest" is the revision latest.json names: the newest one a Publish (or
 * a "Make current") put on the CDN. It says nothing about what a visitor's
 * page shows at this second; the screen never claims that. A revision
 * latest.json never named (a publish that lost its race) is not listed.
 */

import {
  DATED_RELEASE_NOTE,
  MADE_CURRENT_PREFIXES,
  NO_NOTE_TITLE,
  UNKNOWN_RELEASE_NOTES,
} from "@decocms/shared/release-notes";
import type { TFunction } from "@/i18n/use-t.ts";
import { isReleaseRevision } from "@/components/sections-editor/preview-link";
import type { ReleaseRevision } from "./releases-api";

/** The rows the screen lists: every revision that went live. */
export function listedRevisions(
  revisions: readonly ReleaseRevision[],
): ReleaseRevision[] {
  return revisions.filter((r) => r.status !== "never-live");
}

/** Whether the row is the latest release (what latest.json names). */
export function isLatest(revision: Pick<ReleaseRevision, "status">): boolean {
  return revision.status === "current";
}

/**
 * Whether a release can be opened in the preview ("Preview this version"):
 * any listed one, the latest included. The site reads that release by its
 * revision id from a Studio link only.
 */
export function canPreviewRelease(
  revision: Pick<ReleaseRevision, "id" | "status">,
): boolean {
  return revision.status !== "never-live" && isReleaseRevision(revision.id);
}

/** Whether a row offers "Make current": an earlier release that went live. */
export function canReapply(revision: Pick<ReleaseRevision, "status">): boolean {
  return revision.status === "was-live";
}

// The server's note words ("Made current: …", "release from …"), shared with
// apps/api's cms-publish.ts. Publish's no-note title is developer words, never shown.
const NO_NOTE = NO_NOTE_TITLE;

/** A note's title line: the note a Publish wrote. */
const titleLine = (message: string) => message.split("\n")[0]?.trim() ?? "";

/** A date and time in the viewer's language. */
export function formatWhen(date: Date, language: string): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * When a revision was made, from its id: the UUIDv7 after the inverted-time
 * prefix starts with its 48-bit millisecond timestamp. Null for any other id.
 */
export function revisionTime(id: string): Date | null {
  if (!isReleaseRevision(id)) return null;
  const hex = id.slice(13, 21) + id.slice(22, 26);
  const when = new Date(Number.parseInt(hex, 16));
  return Number.isNaN(when.getTime()) ? null : when;
}

/** A release's note in business words (a "Make current" is localized). */
export function releaseTitle(
  t: TFunction,
  meta: { message: string },
  language: string,
): string {
  const title = titleLine(meta.message);
  const prefix = MADE_CURRENT_PREFIXES.find((p) => title.startsWith(p));
  if (prefix) {
    const rest = title.slice(prefix.length).trim();
    const dated = rest.match(DATED_RELEASE_NOTE);
    if (dated) {
      const when = new Date(`${dated[1]}T${dated[2]}:00Z`);
      if (!Number.isNaN(when.getTime())) {
        return t("releases.reapplyOfDate", {
          when: formatWhen(when, language),
        });
      }
    }
    if (!rest || UNKNOWN_RELEASE_NOTES.has(rest) || NO_NOTE.test(rest)) {
      return t("releases.reapplyOf", { title: t("releases.untitled") });
    }
    return t("releases.reapplyOf", { title: rest });
  }
  if (!title || NO_NOTE.test(title)) return t("releases.untitled");
  return title;
}
