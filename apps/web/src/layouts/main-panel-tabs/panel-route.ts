/** The main-panel view as a URL: `/$org/agents/{-$panel}?virtualmcpid=<id>`.
 *  WHICH view is the segment; WHETHER the panel is open is `?mainpanel`, so
 *  closing it no longer erases the view and every view has one shareable
 *  address. The project is search, not a segment — it has to mean the same
 *  thing on `/tasks` and `/library`.
 *  GRAMMAR. One internal vocabulary, the tab id (`tab-id.ts`), spoken by the
 *  tab bar, the per-thread layout memory and the bar's order storage. This
 *  module is the single boundary turning a tab id into a URL and back. Fixed
 *  views are plain words and become the segment as-is; the kinds that carry a
 *  payload put the KIND in the path and the payload in search —
 *  `code:<path>` → `/agents/code?file=src/app.tsx`, `app:<conn>:<tool>` →
 *  `/agents/app?connection=conn_1&tool=get_orders`, and so on for `file`,
 *  `deck`, `library-file` and `automations`. A payload rides in search rather
 *  than nested segments because paths carry `/`, and because nesting only some
 *  of them would split one grammar into two shapes.
 *  A lone `/agents/<word>` is unambiguous now that only one segment is
 *  optional, but the vocabulary below still classifies it: the route's
 *  `beforeLoad` uses {@link isKnownPanelSegment} to tell a view name from a
 *  bookmarked project id and move the latter into `?virtualmcpid=`. */

import {
  FIXED_SYSTEM_TABS,
  GATED_CONTROL_PLANE_TABS,
  formatCodeTabId,
  formatDeckTabId,
  formatFileTabId,
  formatLibraryFileTabId,
  formatPinnedViewTabId,
  isLegacySettingsTab,
  normalizePanelSegment,
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
  /** `site-editor` — {@link CONTENT_MAIN} while the surface is on Content;
   *  absent for the plain preview. */
  main?: string;
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
  "main",
] as const satisfies ReadonlyArray<keyof PanelPayload>;

/**
 * Content's address: `?main=content` on the Site Editor segment.
 *
 * Preview, Content and Code are one surface, so they are one segment
 * (`/agents/site-editor`) and the view within it is this parameter — which
 * makes Content shareable and reload-stable without minting a second home for
 * a place the sidebar already has one row for.
 *
 * The name is deliberate and the collision is real: `main` is otherwise the
 * LEGACY param whose whole job is to translate itself into a segment. This one
 * value is carved out of that translation (see `legacy-route-translation.ts`);
 * every other `main=<tab>` still retires exactly as it did.
 */
export const CONTENT_MAIN = "content";

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
  // Gated, per-site control-plane tabs are excluded: they always appear with a
  // project, so a lone `/agents/<segment>` naming one of them is a project, not
  // a panel word (otherwise a project slugged "hosting"/"analytics"/etc. breaks).
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
  /** Renamed to `site-editor`; still a view name, so a bookmark carrying it is
   *  not mistaken for a project id. `tabIdForPanel` normalises it. */
  "preview",
]);

/**
 * Views that are a destination page of their own rather than a chat panel:
 * opening one is a navigation to that page, not a panel swap. The routes they
 * map to live with the other route literals (`use-destination-route.ts`), so
 * TanStack type-checks them; the vocabulary lives here, with the grammar.
 */
const DESTINATION_PANELS = [
  "board",
  "files",
  "reports",
  "overview",
  "discover",
] as const;

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

  /** Content is a view ON the Site Editor, not a segment beside it — see
   *  {@link CONTENT_MAIN}. Every other view clears `main` along with the rest
   *  of the payload, so leaving Content is what returns the plain preview. */
  if (tabId === CONTENT_MAIN) {
    return {
      panel: "site-editor",
      payload: { ...payload, main: CONTENT_MAIN },
    };
  }

  /** A renamed id (a stored default, a legacy `?main=`) is written out under
   *  its current name — the alias is accepted on input, never emitted. */
  return { panel: normalizePanelSegment(tabId), payload };
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
    default: {
      const view = normalizePanelSegment(panel);
      /** The Site Editor's own view lives in search — `?main=content` is
       *  Content, its absence is the preview. `content` also still arrives as
       *  a SEGMENT, from links minted before it moved, and resolves to the
       *  same view. */
      return view === "site-editor" && payload.main === CONTENT_MAIN
        ? CONTENT_MAIN
        : view;
    }
  }
}
