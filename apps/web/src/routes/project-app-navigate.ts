import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { OVERLAY_TABS } from "@/layouts/main-panel-tabs/tab-id";
import { parseTaskRouteSegment } from "@/layouts/task-board/task-route";

/**
 * An app requests in-panel navigation — rather than sending content to chat —
 * by emitting a lone `studio://navigate?main=<tab>` resource-link message, e.g.
 * the commerce diagnostic report's "task board" button. `main` here is the
 * app-message wire name and is unrelated to the browser URL, which names the
 * view in its path. Restricted to OVERLAY_TABS so a message cannot drive
 * arbitrary navigation.
 */
const NAVIGATE_SCHEME = "studio://navigate";

// `field=<key>` on `main=connect-sources` targets one specific source — the
// commerce report already knows exactly which one it's missing. The caller
// (project-app-view.tsx) opens that source's connect/config dialog in place
// over the app view (ConnectSourceDialog) instead of swapping the panel to
// the connect-sources tab. Allowlisted the same way as OVERLAY_TABS.
const CONNECT_SOURCE_FIELDS = new Set(["vtex", "ga4", "gsc", "github"]);

/**
 * Classifies a `handleAppMessage` payload as a navigate request or not.
 *
 * - `{ isNavigate: false }` — not a navigate message; the caller should fall
 *   through to the normal content-to-chat handling.
 * - `{ isNavigate: true, tab, field, task }` — a navigate message was
 *   intercepted; the caller should stop processing. `tab` is the allowlisted
 *   tab to open, or null if the URI was malformed or targeted a
 *   non-allowlisted tab (in which case the request is silently dropped, not
 *   sent to chat). `field` is the allowlisted source to connect, set only with
 *   `connect-sources`. `task` is the card to open (`task=DECO-12`, `12` or a
 *   raw card id), set only with `board`; an invalid one is dropped and the
 *   board opens.
 */
export function resolveAppNavigateTarget(content: ContentBlock[]):
  | { isNavigate: false }
  | {
      isNavigate: true;
      tab: string | null;
      field: string | null;
      task: string | null;
    } {
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
  let task: string | null = null;
  try {
    const params = new URL(block.uri).searchParams;
    main = params.get("main");
    field = params.get("field");
    task = params.get("task");
  } catch {
    // malformed navigate URI — ignore
  }

  const tab = main && OVERLAY_TABS.has(main) ? main : null;
  return {
    isNavigate: true,
    tab,
    field:
      tab === "connect-sources" && field && CONNECT_SOURCE_FIELDS.has(field)
        ? field
        : null,
    task: tab === "board" && task ? parseTaskRouteSegment(task) : null,
  };
}
