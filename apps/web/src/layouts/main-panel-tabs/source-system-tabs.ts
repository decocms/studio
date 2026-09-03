/** Preview, Content and Code — one Site Editor surface seen three ways, so they
 *  share a switcher there rather than three sidebar rows. What the surface
 *  offers comes from the AGENT and the thread's runtime, never a fetch: Code
 *  browses the sandbox working tree, so a sandbox-less CMS session gets Preview
 *  and Content alone, and Content itself is gated on the agent's CMS mode and
 *  nothing else. It used to wait on `useDecofile`/`useLiveMeta`, so a tab's
 *  existence hung on a read landing late or never — it blinked in, or never
 *  appeared. An empty site is the Content view's own empty state to explain. */

import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";
import type { CmsMode } from "@decocms/shared/sdk/types";
import { isContentEditingEnabled } from "./content-editing-gate";

/** A view of the Site Editor surface. */
export type SurfaceTabId = "site-editor" | "content" | "code";

export function resolveSurfaceTabs(input: {
  /** There is a checked-out clonable source to show — see `preview-source`. */
  hasSource: boolean;
  /** THIS session's runtime, read from the thread's own stamp. */
  runtime: ThreadRuntime;
  /** The agent's CMS mode, already normalised by `resolveCmsMode`. */
  cmsMode: CmsMode;
}): SurfaceTabId[] {
  if (!input.hasSource) return [];
  const tabs: SurfaceTabId[] = ["site-editor"];
  /** The agent's own setting, not a fetch: `off` is the only thing that takes
   *  Content off the surface. */
  if (isContentEditingEnabled(input.cmsMode)) tabs.push("content");
  /** No sandbox, no working tree to browse. */
  if (input.runtime === "sandbox") tabs.push("code");
  return tabs;
}

/**
 * True while the panel is on the Site Editor surface, whose views share the
 * switcher. `code:<path>` is the Code view with a file open.
 */
export function isSurfaceTab(tabId: string): boolean {
  return (
    tabId === "site-editor" ||
    tabId === "content" ||
    tabId === "code" ||
    tabId.startsWith("code:")
  );
}

/**
 * Reports-only orgs surface the Site Editor on every shell, but the storefront
 * it points at lives on the Report Agent. From any other shell the click must
 * deep-link into the Report Agent rather than toggle the current (source-less)
 * agent's panel. On the Report Agent itself it's a normal in-place toggle.
 *
 * Keyed off `isSurfaceTab`, so EVERY view of the surface travels — Content as
 * much as Preview, and Code with a file open (`code:<path>`), which would
 * otherwise stay on the source-less agent and render its empty state.
 */
export function shouldDeepLinkSourceTab(opts: {
  reportsOnly: boolean;
  onReportAgent: boolean;
  tabId: string;
}): boolean {
  return opts.reportsOnly && !opts.onReportAgent && isSurfaceTab(opts.tabId);
}
