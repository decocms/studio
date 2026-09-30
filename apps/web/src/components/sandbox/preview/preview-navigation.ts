import { z } from "zod";
import type { PreviewDeviceHint } from "./preview-device-hint";

/**
 * Cross-origin preview frames (a Local tunnel, a production preview server)
 * can't have their location read by Studio, so a frame that navigates on its
 * own — an app whose links are taps, not anchors — reports the new path with
 * this message. Studio then follows it with the page picker and the Blocks
 * panel, as it does for same-origin sandbox frames on `load`.
 */
export const PREVIEW_NAVIGATED_MESSAGE = "deco-preview::navigated";

const NavigatedSchema = z.object({
  type: z.literal(PREVIEW_NAVIGATED_MESSAGE),
  path: z.string().min(1).max(2048),
});

/**
 * The site path a `deco-preview::navigated` message reports, or null. Only a
 * same-origin absolute path is accepted (no scheme, no `//host`, no
 * backslashes); query and hash are dropped, since the picker matches paths.
 */
export function parsePreviewNavigatedPath(data: unknown): string | null {
  const result = NavigatedSchema.safeParse(data);
  if (!result.success) return null;
  const { path } = result.data;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
    return null;
  const url = new URL(path, "https://preview.invalid");
  if (url.origin !== "https://preview.invalid") return null;
  return url.pathname;
}

/**
 * Whether content edits repaint the frame in place (`/live/previews` POST)
 * even when the project's experimental in-place flag is off. An app preview
 * server (`kind: "eitri-app"`) has no other way to show unsaved content: it
 * doesn't run the deco runtime, so the commit-and-reload draft path would show
 * stale blocks.
 */
export function previewTargetRendersInPlace(
  hint: PreviewDeviceHint | null,
): boolean {
  return hint?.kind === "eitri-app";
}
