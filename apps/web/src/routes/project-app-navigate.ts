import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { OVERLAY_TABS } from "@/layouts/main-panel-tabs/tab-id";

// An app can request in-panel navigation (instead of sending content to chat)
// by emitting a lone `studio://navigate?main=<tab>` resource-link message —
// e.g. the commerce diagnostic report's "task board" button. `main` is
// restricted to OVERLAY_TABS so a message can't drive arbitrary navigation.
// `connectGithub=1` is the one other flag recognized — it opens the same
// "connect GitHub" dialog the task board's Auto-fix gate uses, from the
// commerce report's autopilot card when no repo is connected yet.
const NAVIGATE_SCHEME = "studio://navigate";

/**
 * Classifies a `handleAppMessage` payload as a navigate request or not.
 *
 * - `{ isNavigate: false }` — not a navigate message; the caller should fall
 *   through to the normal content-to-chat handling.
 * - `{ isNavigate: true, tab, connectGithub }` — a navigate message was
 *   intercepted; the caller should stop processing. `tab` is the allowlisted
 *   tab to open, or null if the URI was malformed or targeted a
 *   non-allowlisted tab (in which case that part of the request is silently
 *   dropped, not sent to chat). `connectGithub` is true only for an exact
 *   `connectGithub=1`.
 */
export function resolveAppNavigateTarget(
  content: ContentBlock[],
):
  | { isNavigate: false }
  | { isNavigate: true; tab: string | null; connectGithub: boolean } {
  const [block] = content;
  if (
    content.length !== 1 ||
    block?.type !== "resource_link" ||
    !block.uri.startsWith(NAVIGATE_SCHEME)
  ) {
    return { isNavigate: false };
  }

  let main: string | null = null;
  let connectGithub = false;
  try {
    const params = new URL(block.uri).searchParams;
    main = params.get("main");
    connectGithub = params.get("connectGithub") === "1";
  } catch {
    // malformed navigate URI — ignore
  }

  return {
    isNavigate: true,
    tab: main && OVERLAY_TABS.has(main) ? main : null,
    connectGithub,
  };
}
