/**
 * Pure gate for the bottom terminal drawer (the `sandbox` strip with the
 * Start/Stop controls and the setup/script log tabs).
 *
 * The drawer is a window onto a sandbox pod: its status pill, its Stop button
 * and its log tabs all read the sandbox lifecycle. A Fast Preview session has
 * no pod — the CMS reads/writes GitHub through the decofile API and the preview
 * renders against the production URL — so the drawer would sit there pinned at
 * "starting" (the `computePreviewState` fallback for "no previewUrl") next to a
 * Stop button for something that will never boot.
 *
 * Sandbox sessions get it unconditionally: there is no show/hide toggle, so this
 * gate is the only thing standing between a session and its terminal.
 */

import { OVERLAY_TABS } from "./tab-id";

export interface TerminalDrawerGateInput {
  /** The agent (or the thread, via `load_repo`) has a repo to clone. */
  hasClonableSource: boolean;
  /**
   * The session resolves to the sandbox-less CMS runtime — `resolveFastPreview`
   * of the vMCP metadata plus the active thread's `runtime` stamp. `false` means
   * the session runs on a sandbox.
   */
  fastPreviewActive: boolean;
  /** Current `?main=` tab id, or `null` when unset. */
  mainTab: string | null;
}

export function shouldShowTerminalDrawer(
  input: TerminalDrawerGateInput,
): boolean {
  return (
    input.hasClonableSource &&
    !input.fastPreviewActive &&
    !(input.mainTab !== null && OVERLAY_TABS.has(input.mainTab))
  );
}
