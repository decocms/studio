/**
 * The main-panel view as a URL: `/$org/agents/{-$project}/{-$panel}`.
 *
 * `?main=` used to conflate two things — WHICH view is showing, and WHETHER the
 * main panel is open at all (the `0` sentinel) — which is exactly why a view
 * could not be a path segment. They are split now:
 *
 *   path segment   which view      /$org/agents/vir_x/preview
 *   ?mainpanel=    is it open      a boolean, mirroring ?sidepanel
 *
 * so closing the panel no longer erases which view you were on, and every view
 * has one shareable address.
 *
 * GRAMMAR. The app keeps ONE vocabulary internally — the tab id (see
 * `tab-id.ts`), which the tab bar, the per-thread layout memory and the bar's
 * order storage all speak. This module is the single boundary that turns a tab
 * id into a URL and back. Eight fixed views are plain words and become the
 * segment as-is; the six kinds that carry a payload put the KIND in the path
 * and the payload in search:
 *
 *   code:<path>          → /agents/:project/code?file=src/app.tsx
 *   file:<key>           → /agents/:project/file?key=org-fs:outputs/…
 *   deck:<path>          → /agents/:project/deck?deck=decks/q3.html
 *   library-file:<path>  → /agents/:project/library-file?path=home/docs/a.md
 *   app:<conn>:<tool>    → /agents/:project/app?connection=conn_1&tool=get_orders
 *   automation:<id>      → /agents/:project/automations?automation=<id>
 *
 * A payload rides in search rather than in nested segments (`/app/:conn/:tool`)
 * on purpose: paths carry `/`, so `code`/`deck`/`file`/`library-file` could not
 * be segments at all without re-encoding, and giving only `app` and
 * `automations` nested routes would split one grammar into two shapes and add
 * dynamic siblings under the chat node — the ranking hazard `router.tsx`
 * documents. One optional segment, one route, one parser.
 *
 * AMBIGUITY. `{-$project}` and `{-$panel}` are both optional, so `/agents/preview`
 * (a view on the Super Agent, which has no project segment) matches with
 * `project="preview"`: TanStack fills the first optional segment. Project ids
 * are opaque prefixed ids (`vir_…`, `decopilot_…`) and never plain words, so
 * {@link resolveChatSegments} reads a lone segment from the known panel
 * vocabulary back as the panel. Every reader of the pair goes through it —
 * `useActivePanelTabId` and `usePanelNavigate` here, and everything else via
 * `useRouteProjectId` (`layouts/thread-route.ts`). Reading `params.project`
 * raw hands a VIEW name to the agent lookup, and the workspace renders
 * "Agent not found" for a URL the panel writers themselves mint.
 */

import {
  FIXED_SYSTEM_TABS,
  formatCodeTabId,
  formatDeckTabId,
  formatFileTabId,
  formatLibraryFileTabId,
  formatPinnedViewTabId,
  isLegacySettingsTab,
  OVERLAY_TABS,
  parseAutomationTabId,
  parseCodeTabId,
  parseDeckTabId,
  parseFileTabId,
  parseLibraryFileTabId,
  parsePinnedViewTabId,
} from "./tab-id";

/** The active panel's parameter, by panel kind. At most one kind's keys are
 *  ever set; the rest are written as `undefined` so switching panels can never
 *  leave the previous one's parameter behind in the URL. */
export interface PanelPayload {
  /** `code` — repo-relative path of the open file. */
  file?: string;
  /** `file` — the thread output's org-fs key. */
  key?: string;
  /** `deck` — home-volume path of the HTML artifact. */
  deck?: string;
  /** `library-file` — org Library browse path. */
  path?: string;
  /** `app` — the connection the pinned view's tool belongs to. */
  connection?: string;
  /** `app` — the tool that renders the view. */
  tool?: string;
  /** `automations` — the automation whose detail is open (absent = the list). */
  automation?: string;
}

/** Every payload key, so a writer can clear the ones it does not use. */
export const PANEL_PAYLOAD_KEYS = [
  "file",
  "key",
  "deck",
  "path",
  "connection",
  "tool",
  "automation",
] as const satisfies ReadonlyArray<keyof PanelPayload>;

/** A view's URL: the `{-$panel}` segment plus the search that parameterizes it. */
export interface PanelLocation {
  panel: string | undefined;
  payload: PanelPayload;
}

/** Every payload key set to `undefined` — what a view with no parameter of its
 *  own writes, so the previous view's cannot outlive it. */
export function clearPanelPayload(): PanelPayload {
  const cleared: Record<string, undefined> = {};
  for (const key of PANEL_PAYLOAD_KEYS) cleared[key] = undefined;
  return cleared;
}

/**
 * Panel segments that are plain words — everything a lone `/agents/<segment>` can
 * mean other than a project. Agent-declared tab ids are NOT here and never need
 * to be: they come from a project's own metadata, so their URL always names the
 * project too.
 */
const KNOWN_PANEL_SEGMENTS: ReadonlySet<string> = new Set<string>([
  ...FIXED_SYSTEM_TABS,
  ...OVERLAY_TABS,
  "app",
  "file",
  "deck",
  "library-file",
  "connect-sources",
  "instructions",
  "connections",
  "layout",
]);

/**
 * Views that are a destination page of their own rather than a chat panel:
 * opening one is a navigation to that page, not a panel swap. The routes they
 * map to live with the other route literals (`use-destination-route.ts`), so
 * TanStack type-checks them; the vocabulary lives here, with the grammar.
 */
const DESTINATION_PANELS = ["board", "files", "reports", "overview"] as const;

export type DestinationPanel = (typeof DESTINATION_PANELS)[number];

const DESTINATION_PANEL_SET: ReadonlySet<string> = new Set<string>(
  DESTINATION_PANELS,
);

export function isDestinationPanel(tabId: string): tabId is DestinationPanel {
  return DESTINATION_PANEL_SET.has(tabId);
}

/** True for a segment that names a view rather than a project. */
export function isKnownPanelSegment(segment: string | undefined): boolean {
  return !!segment && KNOWN_PANEL_SEGMENTS.has(segment);
}

/**
 * The `{-$project}` / `{-$panel}` pair as the app means it, from the pair
 * TanStack matched. A lone panel segment lands in `project` (both params are
 * optional, so the first one wins the segment), and moves here.
 */
export function resolveChatSegments(params: {
  project?: string;
  panel?: string;
}): { project: string | undefined; panel: string | undefined } {
  if (params.panel === undefined && isKnownPanelSegment(params.project)) {
    return { project: undefined, panel: params.project };
  }
  return { project: params.project, panel: params.panel };
}

/** The URL a tab id is written as. */
export function panelLocationForTab(tabId: string): PanelLocation {
  const payload = clearPanelPayload();

  const pinned = parsePinnedViewTabId(tabId);
  if (pinned) {
    return {
      panel: "app",
      payload: {
        ...payload,
        connection: pinned.connectionId,
        tool: pinned.toolName,
      },
    };
  }

  const automation = parseAutomationTabId(tabId);
  if (automation) {
    return {
      panel: "automations",
      payload: { ...payload, automation: automation.id },
    };
  }

  const file = parseFileTabId(tabId);
  if (file) return { panel: "file", payload: { ...payload, key: file.key } };

  const deck = parseDeckTabId(tabId);
  if (deck) return { panel: "deck", payload: { ...payload, deck: deck.path } };

  const libraryFile = parseLibraryFileTabId(tabId);
  if (libraryFile) {
    return {
      panel: "library-file",
      payload: { ...payload, path: libraryFile.path },
    };
  }

  const code = parseCodeTabId(tabId);
  if (code) {
    return {
      panel: "code",
      payload: { ...payload, file: code.path ?? undefined },
    };
  }

  /** The three merged tabs share one view, so they share one address. */
  if (isLegacySettingsTab(tabId)) return { panel: "settings", payload };

  return { panel: tabId, payload };
}

/**
 * The tab id a URL names, or `undefined` when it names no view — the panel then
 * rests on the route's or the agent's default (see `resolveActiveTabAndOpen`).
 *
 * A kind whose payload is missing (a hand-truncated link) names no view either,
 * rather than a tab id no parser accepts. The two kinds with a meaningful bare
 * form keep it: the file tree for `code`, the list for `automations`.
 */
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
    default:
      return panel;
  }
}
