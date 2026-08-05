import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { OVERLAY_TABS } from "@/layouts/main-panel-tabs/tab-id";

// An app can request in-panel navigation (instead of sending content to chat)
// by emitting a lone `studio://navigate?main=<tab>` resource-link message —
// e.g. the commerce diagnostic report's "task board" button. Restricted to
// OVERLAY_TABS so a message can't drive arbitrary navigation.
const NAVIGATE_SCHEME = "studio://navigate";

// `field=<key>` deep-links `main=connect-sources` straight to one companion's
// own connect/config dialog (skipping the card grid) — the commerce report
// already knows exactly which source it's missing. Allowlisted the same way
// as OVERLAY_TABS; meaningless (and ignored) for any other tab.
const CONNECT_SOURCE_FIELDS = new Set(["vtex", "ga4", "gsc", "github"]);

/**
 * Classifies a `handleAppMessage` payload as a navigate request or not.
 *
 * - `{ isNavigate: false }` — not a navigate message; the caller should fall
 *   through to the normal content-to-chat handling.
 * - `{ isNavigate: true, tab, field }` — a navigate message was intercepted;
 *   the caller should stop processing. `tab` is the allowlisted tab to open,
 *   or null if the URI was malformed or targeted a non-allowlisted tab (in
 *   which case the request is silently dropped, not sent to chat). `field` is
 *   the allowlisted companion to focus within that tab, or null.
 */
export function resolveAppNavigateTarget(
  content: ContentBlock[],
):
  | { isNavigate: false }
  | { isNavigate: true; tab: string | null; field: string | null } {
  const [block] = content;
  if (
    content.length !== 1 ||
    block?.type !== "resource_link" ||
    !block.uri.startsWith(NAVIGATE_SCHEME)
  ) {
    return { isNavigate: false };
  }

  let main: string | null = null;
  let field: string | null = null;
  try {
    const params = new URL(block.uri).searchParams;
    main = params.get("main");
    field = params.get("field");
  } catch {
    // malformed navigate URI — ignore
  }

  return {
    isNavigate: true,
    tab: main && OVERLAY_TABS.has(main) ? main : null,
    field: field && CONNECT_SOURCE_FIELDS.has(field) ? field : null,
  };
}
