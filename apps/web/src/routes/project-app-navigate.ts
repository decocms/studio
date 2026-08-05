import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { OVERLAY_TABS } from "@/layouts/main-panel-tabs/tab-id";

// An app can request in-panel navigation (instead of sending content to chat)
// by emitting a lone `studio://navigate?main=<tab>` resource-link message —
// e.g. the commerce diagnostic report's "task board" button. Restricted to
// OVERLAY_TABS so a message can't drive arbitrary navigation.
const NAVIGATE_SCHEME = "studio://navigate";

/**
 * Classifies a `handleAppMessage` payload as a navigate request or not.
 *
 * - `{ isNavigate: false }` — not a navigate message; the caller should fall
 *   through to the normal content-to-chat handling.
 * - `{ isNavigate: true, tab }` — a navigate message was intercepted; the
 *   caller should stop processing. `tab` is the allowlisted tab to open, or
 *   null if the URI was malformed or targeted a non-allowlisted tab (in which
 *   case the request is silently dropped, not sent to chat).
 */
export function resolveAppNavigateTarget(
  content: ContentBlock[],
): { isNavigate: false } | { isNavigate: true; tab: string | null } {
  const [block] = content;
  if (
    content.length !== 1 ||
    block?.type !== "resource_link" ||
    !block.uri.startsWith(NAVIGATE_SCHEME)
  ) {
    return { isNavigate: false };
  }

  let main: string | null = null;
  try {
    main = new URL(block.uri).searchParams.get("main");
  } catch {
    // malformed navigate URI — ignore
  }

  return {
    isNavigate: true,
    tab: main && OVERLAY_TABS.has(main) ? main : null,
  };
}
