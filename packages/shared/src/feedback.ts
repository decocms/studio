/**
 * Limits for in-app feedback (`POST /api/:org/feedback`), shared so the
 * sidebar dialog refuses what the API would.
 */

export const FEEDBACK_MAX_MESSAGE_CHARS = 10_000;
export const FEEDBACK_MAX_SCREENSHOTS = 3;
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
/** Raster only, so no script of the file's own runs when the card renders it. */
export const FEEDBACK_SCREENSHOT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];
