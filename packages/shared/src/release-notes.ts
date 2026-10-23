/**
 * The words a reapplied release's note is written in. The server writes them
 * (`apps/api/src/hosted/reapply.ts`) and the Releases screen reads them back
 * (`releases-status.ts`) to show the note in the viewer's language, so both
 * sides take them from here.
 */

/** The note's prefix: the Releases screen's "Make current" action. */
export const MADE_CURRENT_PREFIX = "Made current: ";

/** The prefix notes had before the action was named "Make current". */
export const LEGACY_MADE_CURRENT_PREFIX = "Reapply: ";

/** Every prefix a reapplied release's note may start with, newest first. */
export const MADE_CURRENT_PREFIXES = [
  MADE_CURRENT_PREFIX,
  LEGACY_MADE_CURRENT_PREFIX,
] as const;

/** Publish's fallback title when there was no note (`decofileCommitMessage`). */
export const NO_NOTE_TITLE = /^chore\(decofile\):/;

/** A reapplied release with no note is named by its date, `YYYY-MM-DD HH:MM UTC`. */
export function datedReleaseNote(utcMinute: string): string {
  return `release from ${utcMinute}`;
}

/** The dated note, as written now ("release") and before ("version"). */
export const DATED_RELEASE_NOTE =
  /^(?:release|version) from (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/;

/** The note when even the date was unreadable. */
export const UNKNOWN_RELEASE_NOTE = "earlier release";

/** {@link UNKNOWN_RELEASE_NOTE}, as written now and before. */
export const UNKNOWN_RELEASE_NOTES: ReadonlySet<string> = new Set([
  UNKNOWN_RELEASE_NOTE,
  "earlier version",
]);
