/**
 * Limits for in-app feedback (`POST /api/:org/feedback`), shared so the
 * Help menu's dialog refuses what the API would.
 */

export const FEEDBACK_MAX_MESSAGE_CHARS = 10_000;
export const FEEDBACK_MAX_SCREENSHOTS = 3;
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
/** Raster only, so no script of the file's own runs when the card renders it. */
export const FEEDBACK_SCREENSHOT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** "problem" comes from Help › Report a problem, so support can triage it apart. */
export const FEEDBACK_KINDS = ["feedback", "problem"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_TAG_NAME = "feedback button";
export const PROBLEM_REPORT_TAG_NAME = "problem report";
export const FEEDBACK_TAG_NAMES: Readonly<Record<FeedbackKind, string>> = {
  feedback: FEEDBACK_TAG_NAME,
  problem: PROBLEM_REPORT_TAG_NAME,
};
