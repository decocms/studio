/** Gaps owned by us when this install has no browser or object storage. */

import type { SourceGap } from "../types.ts";

/** Why pages are not opened in this run. */
const BROWSER_UNAVAILABLE = "navegador indisponível nesta instalação";

export const browserGap = (): SourceGap => ({
  source: "browser",
  error: BROWSER_UNAVAILABLE,
});

/** Why captures and repository snapshots are not kept: nowhere to put them. */
export const MEDIA_UNAVAILABLE =
  "armazenamento de imagens indisponível nesta instalação";
