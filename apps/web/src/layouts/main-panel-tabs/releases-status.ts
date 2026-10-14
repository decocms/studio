/**
 * What each row of the Releases screen says, as pure functions: its title in
 * business words, and its pill.
 *
 * "Live" is the release the site itself reports serving (`serving`, from its
 * telemetry). The release just published (what latest.json names) is
 * "Going live…" until the site reports it, for up to ten minutes; after
 * that it is "Published" with a hint that the site hasn't confirmed it. A
 * site that reports nothing (`serving.source === "none"`) falls back to the
 * last publish: that row is "Live", with a hint saying it's based on it.
 */

import type { TFunction } from "@/i18n/use-t.ts";
import type {
  ReleaseCommit,
  ReleasePointer,
  ReleaseServing,
} from "./releases-api";

/** How long a just-published release waits for the site to report it. */
export const GOING_LIVE_WINDOW_MS = 10 * 60_000;
/** How often the screen asks again while it waits. */
export const GOING_LIVE_POLL_MS = 15_000;

export type ReleaseBadge =
  | { kind: "live"; hint: "liveHint" | null }
  | { kind: "goingLive"; hint: "goingLiveHint" }
  | { kind: "published"; hint: "notReportedHint" };

interface ReleasesState {
  current: ReleasePointer | null;
  serving: ReleaseServing | null;
}

function recentlyPublished(current: ReleasePointer, now: number): boolean {
  const at = Date.parse(current.publishedAt);
  return Number.isFinite(at) && now - at < GOING_LIVE_WINDOW_MS;
}

/** The pill of the row for commit `sha`, or null for none. */
export function releaseBadge(
  sha: string,
  { current, serving }: ReleasesState,
  now: number = Date.now(),
): ReleaseBadge | null {
  if (!serving || serving.source === "none") {
    return sha === current?.revision
      ? { kind: "live", hint: "liveHint" }
      : null;
  }
  if (sha === serving.revision) return { kind: "live", hint: null };
  if (current && sha === current.revision) {
    return recentlyPublished(current, now)
      ? { kind: "goingLive", hint: "goingLiveHint" }
      : { kind: "published", hint: "notReportedHint" };
  }
  return null;
}

/** Whether the screen should ask again soon: the last publish isn't confirmed. */
export function waitingForSite(
  { current, serving }: ReleasesState,
  now: number = Date.now(),
): boolean {
  if (!current || !recentlyPublished(current, now)) return false;
  return serving?.source !== "site" || serving.revision !== current.revision;
}

/** Whether a row offers Republish: a release the site doesn't show already. */
export function canRepublish(
  commit: ReleaseCommit,
  { current, serving }: ReleasesState,
): boolean {
  if (!commit.hasRelease) return false;
  if (commit.sha === current?.revision) return false;
  return !(serving?.source === "site" && commit.sha === serving.revision);
}

const REPUBLISH_PREFIX = "Republish: ";
const REPUBLISH_OF_DATE =
  /^release from (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/;
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

/** A release's note in business words (a republish is localized). */
export function releaseTitle(
  t: TFunction,
  commit: Pick<ReleaseCommit, "message" | "hasRelease">,
  language: string,
): string {
  if (!commit.hasRelease) return t("releases.siteUpdate");
  const title = titleLine(commit.message);
  if (title.startsWith(REPUBLISH_PREFIX)) {
    const rest = title.slice(REPUBLISH_PREFIX.length).trim();
    const dated = rest.match(REPUBLISH_OF_DATE);
    if (dated) {
      const when = new Date(`${dated[1]}T${dated[2]}:00Z`);
      if (!Number.isNaN(when.getTime())) {
        return t("releases.republishOfDate", {
          when: formatWhen(when, language),
        });
      }
    }
    if (!rest || rest === "earlier release" || NO_NOTE.test(rest)) {
      return t("releases.republishOf", { title: t("releases.untitled") });
    }
    return t("releases.republishOf", { title: rest });
  }
  if (!title || NO_NOTE.test(title)) return t("releases.untitled");
  return title;
}
