/**
 * The URL-bar label for the preview toolbar — the domain (plus path) the user
 * sees for the currently rendered page.
 *
 * It derives the host from `iframeBase` — the URL actually loaded in the iframe
 * — NOT from the sandbox `previewUrl`. Under Fast Preview / the waking fallback
 * the iframe shows the production origin, so the label must follow it or it
 * drifts (showing the sandbox `.localhost` while production is on screen).
 */
export function buildPreviewLabel(input: {
  /** The URL loaded in the iframe (`display.iframeBase`): production or sandbox. */
  iframeBase: string | null;
  /** Current resolved path (template filled in). `"/"` renders as bare host. */
  resolvedPath: string;
  /** Name of the pinned global section, if one is being previewed. */
  activeGlobalSectionName: string | null;
  /** Fallback shown when there's no surface loaded (`mode === "none"`). */
  noServerLabel: string;
}): string {
  // A pinned global section is previewed on a synthetic page — show its name,
  // not a host, exactly as before.
  if (input.activeGlobalSectionName) return input.activeGlobalSectionName;
  const base = input.iframeBase;
  if (!base) return input.noServerLabel;
  try {
    const url = new URL(base);
    const path = input.resolvedPath === "/" ? "" : input.resolvedPath;
    return `${url.host}${path}`;
  } catch {
    return base;
  }
}
