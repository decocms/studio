/**
 * Parser for the retired view-first `/agents/<panel>?virtualmcpid=<agent>`
 * grammar. Canonical navigation is owned exclusively by `tab-route.ts`; this
 * module remains only so durable legacy links can be translated one way into
 * that route tree.
 */

import {
  FIXED_SYSTEM_TABS,
  GATED_CONTROL_PLANE_TABS,
  OVERLAY_TABS,
  formatCodeTabId,
  formatDeckTabId,
  formatFileTabId,
  formatLibraryFileTabId,
  formatPinnedViewTabId,
  normalizePanelSegment,
} from "./tab-id";

export interface PanelPayload {
  file?: string;
  key?: string;
  deck?: string;
  path?: string;
  connection?: string;
  tool?: string;
  automation?: string;
  main?: string;
}

const KNOWN_LEGACY_PANEL_SEGMENTS: ReadonlySet<string> = new Set([
  ...FIXED_SYSTEM_TABS.filter((tab) => !GATED_CONTROL_PLANE_TABS.has(tab)),
  ...OVERLAY_TABS,
  "app",
  "file",
  "deck",
  "library-file",
  "connect-sources",
  "instructions",
  "connections",
  "layout",
  "preview",
]);

/** True when a lone legacy segment names a view rather than an agent. */
export function isKnownPanelSegment(segment: string | undefined): boolean {
  return !!segment && KNOWN_LEGACY_PANEL_SEGMENTS.has(segment);
}

/** Decode one legacy panel plus its search-carried payload to a tab id. */
export function tabIdForPanel(
  panel: string | undefined,
  payload: PanelPayload,
): string | undefined {
  if (!panel) return undefined;

  switch (panel) {
    case "app":
      return payload.connection && payload.tool
        ? formatPinnedViewTabId(payload.connection, payload.tool)
        : undefined;
    case "automations":
      return payload.automation
        ? `automation:${payload.automation}`
        : "automations";
    case "file":
      return payload.key ? formatFileTabId(payload.key) : undefined;
    case "deck":
      return payload.deck ? formatDeckTabId(payload.deck) : undefined;
    case "library-file":
      return payload.path ? formatLibraryFileTabId(payload.path) : undefined;
    case "code":
      return payload.file ? formatCodeTabId(payload.file) : "code";
    default: {
      const view = normalizePanelSegment(panel);
      return view === "site-editor" && payload.main === "content"
        ? "content"
        : view;
    }
  }
}
