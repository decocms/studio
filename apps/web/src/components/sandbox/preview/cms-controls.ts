/**
 * Pure gate for the Preview toolbar's CMS affordances (the "CMS"/Edit toggle
 * and the page selector dropdown).
 *
 * Those two controls only mean anything for a repo that uses the deco framework
 * for sites: they edit and navigate decofile pages/global sections. Studio
 * itself — and any other plain app repo previewed on a coding agent — has no
 * decofile, so rendering them there is misleading (the selector degrades into
 * showing the raw preview host, e.g. "pedro-je4bq0tm-38bb…"). Those repos get
 * the plain browser controls (refresh + open in new tab) only.
 *
 * The question is *framework presence*, NOT "is there content right now". So
 * the gate reads the one state that proves absence — `empty` with reason
 * `framework-missing` (the decofile/meta reads 404'd) — and hides only there. In
 * particular a real deco site with an empty decofile stays `no-content` and keeps
 * its controls, which is how "Create page" (rendered inside the page-selector
 * dropdown) remains reachable for a site that has no pages yet. A data error
 * doesn't revoke the capability either: it means the reads never resolved, so
 * absence is unproven, and the toolbar degrades to its pre-existing behaviour
 * rather than dropping controls out from under a working site.
 *
 * `loading` hides, so the controls never flash in for a repo that turns out not
 * to be a deco site.
 */

import type { BlocksTabState } from "@/layouts/main-panel-tabs/blocks-tab-state";

export function showCmsControls(input: {
  /** Toolbar itself is visible (an iframe surface is active). */
  showPreviewToolbar: boolean;
  blocksState: BlocksTabState;
}): boolean {
  if (!input.showPreviewToolbar) return false;
  const state = input.blocksState;
  switch (state.kind) {
    case "loading":
      return false;
    case "empty":
      return state.reason !== "framework-missing";
    case "content":
    case "error":
      return true;
  }
}
