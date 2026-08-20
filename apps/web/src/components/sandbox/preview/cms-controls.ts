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
 * The signal is the very same readiness classification the Blocks/CMS panel
 * uses (`resolveBlocksTabState`): `content` means the decofile AND live meta
 * reads resolved and there is editable deco content, i.e. this really is a deco
 * site. A non-deco repo resolves to `empty` (404 on the reads) or `error`, and a
 * site whose data is still coming resolves to `loading` — in both cases the
 * controls stay hidden until the capability is proven, so they never flash in
 * for a repo that turns out not to be a deco site.
 */

import type { BlocksTabState } from "@/layouts/main-panel-tabs/blocks-tab-state";

export function showCmsControls(input: {
  /** Toolbar itself is visible (an iframe surface is active). */
  showPreviewToolbar: boolean;
  blocksState: BlocksTabState;
}): boolean {
  return input.showPreviewToolbar && input.blocksState.kind === "content";
}
