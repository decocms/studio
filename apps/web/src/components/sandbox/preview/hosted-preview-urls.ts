/**
 * The hosted v8 preview's two URLs: the frame's and "Open in new tab"'s. Both
 * carry exactly the same `?__draft=` (preview-draft-link.ts): the current
 * draft's pointer with the frame's forced variants and "Preview as" options.
 * The frame adds only its own device hint (and, in preview.tsx, the render
 * flags). No pointer yet: no frame URL (the display holds a loader) and no
 * new-tab link, never the bare site or `off`.
 */

import {
  previewDraftLink,
  previewDraftValue,
  type PreviewDraftModifiers,
} from "@/components/sections-editor/preview-draft-link";
import { type PreviewDeviceSize, withDeviceHint } from "./device-hint";
import type { PreviewDisplay } from "./preview-display";

export interface HostedPreviewUrls {
  /** The exact `__draft` value; `null` without a pointer. */
  value: string | null;
  /** The frame's URL; `null` when the frame isn't on the site. */
  frame: string | null;
  /** "Open in new tab"; `null` until the pointer is read. */
  newTab: string | null;
}

export function hostedPreviewUrls(
  input: {
    display: Pick<PreviewDisplay, "mode" | "iframeBase">;
    /** The page, with any `:param` values filled in. */
    path: string;
    pointer: string | null;
    device: PreviewDeviceSize;
  } & PreviewDraftModifiers,
): HostedPreviewUrls {
  const value = previewDraftValue(input);
  const { display } = input;
  let page: string | null = null;
  if (display.mode === "production" && display.iframeBase) {
    try {
      page = new URL(input.path, display.iframeBase).href;
    } catch {
      page = null;
    }
  }
  const newTab = previewDraftLink(page, value);
  return {
    value,
    frame: newTab ? withDeviceHint(newTab, input.device) : null,
    newTab,
  };
}
