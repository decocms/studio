/** Terminal error codes carried in link `{type:"error", code}` frames /
 *  dispatch SSE error events. A thin shared vocabulary — each transport maps
 *  INTO these where meaningful. NOT a unified cancel model. */
export const LINK_ERROR_CODES = [
  "publish_failed",
  "ws_closed",
  "harness_crashed",
  "bad_input",
  "unknown_harness",
  "tombstoned",
  "offload_fetch_failed",
] as const;

export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];
