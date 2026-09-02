/**
 * Legacy URL → first-class-navigation translation. Three rules live here, all
 * pure: `/$org/$taskId` (the old one-route workspace), `?task=` (the card's
 * address before it had a path of its own) and `?main=` (the view's).
 *
 * Every surface used to live on one thread route, and the sidebar's
 * destinations and the main panel's views were all `?main=<tabId>` overlays. A
 * destination is a real path segment now and so is the view, so the legacy
 * route (which stays mounted forever, for every bookmark and shared link ever
 * minted) translates itself on entry.
 *
 * The governing rule: **path = which page, search = how that page is laid out.**
 * So `virtualmcpid` becomes `?virtualmcpid=`, the thread id
 * moves from the path to `?thread=`, and `main` splits in two: the view it named
 * becomes the `{-$panel}` segment, and its `0` closed sentinel becomes
 * `?mainpanel=false`, which is layout and stays in search.
 *
 * This is a **pure** function of `(org, taskId, search)`: no fetch, no thread
 * lookup, no React. It can be pure because `threads.virtual_mcp_id` is NOT NULL
 * — one agent per thread — so `/$org/agents?thread=<id>` resolves its own project
 * from the row the chat route loads anyway. The translator never needs to know
 * which agent owns the thread, which is what keeps the redirect instant and
 * impossible to serve stale.
 *
 * The four destination-backed `main` values drop the project **deliberately**:
 * today `main=board` on a coding agent shows the ORG-WIDE board (see the
 * docblock at `components/sidebar/nav-destinations.tsx`), so carrying the
 * project forward would invent a filter the old URL never had.
 *
 * `main=connect-sources` is an overlay tab with no destination route of its own,
 * so it becomes a chat panel segment exactly like a per-agent view
 * (`preview` / `code` / `content` / …).
 */

import {
  CONTENT_MAIN,
  type DestinationPanel,
  isDestinationPanel,
  panelLocationForTab,
} from "@/layouts/main-panel-tabs/panel-route";

/** The legacy `/$org/$taskId` search params this translator reads. Every other
 *  key (`sidepanel`, `task`, `connect`, board filters, …) is carried through
 *  verbatim. */
export interface LegacyThreadSearch {
  /** Legacy agent selector. Carried through as `?virtualmcpid=`, the one
   *  carrier of the project scope — it is search on the new routes too. */
  virtualmcpid?: string;
  /** Active main-panel view, or the `0` closed sentinel. Retired into the
   *  `{-$panel}` segment and `?mainpanel` by {@link translateLegacyMainParam}. */
  main?: string | 0;
  [key: string]: unknown;
}

/** Full paths of the destination routes this translator can land on. */
export type LegacyThreadDestination =
  | "/$org/agents/{-$panel}"
  | "/$org/tasks/{-$taskKey}"
  | "/$org/reports"
  | "/$org/library"
  | "/$org/home"
  | "/$org/discover";

/** Shaped for TanStack's `navigate()` / `<Navigate />`: `{ to, params, search }`. */
export interface LegacyThreadTarget {
  to: LegacyThreadDestination;
  params: {
    org: string;
    project: string | undefined;
    panel: string | undefined;
  };
  search: Record<string, unknown> & { thread: string };
}

/** `main` values that became their own destination route. The project segment
 *  is dropped for these — see the module docblock. */
const DESTINATION_BY_PANEL: Readonly<
  Record<DestinationPanel, LegacyThreadDestination>
> = {
  board: "/$org/tasks/{-$taskKey}",
  files: "/$org/library",
  reports: "/$org/reports",
  overview: "/$org/home",
  /** No legacy `?main=discover` was ever minted — Discover postdates the
   *  overlay grammar. Mapped anyway so the record stays exhaustive. */
  discover: "/$org/discover",
};

/**
 * What a legacy `?main=` becomes, for whichever route it arrived on. `null`
 * when there is nothing to translate.
 *
 * `to: null` means "the page you are already on": the closed sentinel is panel
 * visibility, which every page has, so it must not move anyone.
 */
export interface LegacyMainTranslation {
  to: LegacyThreadDestination | null;
  /** The `{-$panel}` segment, when landing on the chat route. */
  panel: string | undefined;
  /** `main` cleared, plus the panel's payload and any `mainpanel`. Layered over
   *  the rest of the search, so a stale payload key can never survive. */
  search: Record<string, unknown>;
}

export function translateLegacyMainParam(
  main: string | 0 | undefined,
  /** The `{-$panel}` segment the URL already carries, when it has one. */
  currentPanel?: string,
): LegacyMainTranslation | null {
  if (main === undefined) return null;
  /**
   * `main=content` is the ONE value that is not legacy: it is Content's own
   * address on the Site Editor segment (see `CONTENT_MAIN`), so it is carried
   * onto that segment rather than retired into one. Once the URL holds both
   * halves there is nothing left to translate — without this the redirect
   * would re-fire on the target it just produced. Every other `main=<tab>`
   * falls through and translates exactly as it did before.
   */
  if (main === CONTENT_MAIN && currentPanel === "site-editor") return null;
  const cleared = { main: undefined };

  if (main === 0 || main === "0") {
    return {
      to: null,
      panel: undefined,
      search: { ...cleared, mainpanel: false },
    };
  }

  const { panel, payload } = panelLocationForTab(main);

  if (panel && isDestinationPanel(panel)) {
    return {
      to: DESTINATION_BY_PANEL[panel],
      panel: undefined,
      search: { ...cleared, ...payload },
    };
  }

  return {
    to: "/$org/agents/{-$panel}",
    panel,
    search: { ...cleared, ...payload },
  };
}

export function translateLegacyThreadRoute(args: {
  org: string;
  taskId: string;
  search?: LegacyThreadSearch | null;
}): LegacyThreadTarget {
  const { org, taskId } = args;
  const { virtualmcpid, main, ...rest } = args.search ?? {};

  const view = translateLegacyMainParam(main);

  if (view && view.to && view.to !== "/$org/agents/{-$panel}") {
    return {
      to: view.to,
      params: { org, project: undefined, panel: undefined },
      /** `virtualmcpid: undefined` is written, not omitted. The key is retained
       *  across navigation, and retention re-adds a key the next search leaves
       *  out — so dropping it by omission would hand the scope straight back on
       *  a page that has no project. */
      search: {
        ...rest,
        ...view.search,
        virtualmcpid: undefined,
        thread: taskId,
      },
    };
  }

  /** A blank agent id would interpolate into an empty segment, so it reads as
   *  "no project" (the Super Agent), same as an absent one. */
  const project = virtualmcpid?.trim() ? virtualmcpid : undefined;

  return {
    to: "/$org/agents/{-$panel}",
    params: { org, project, panel: view?.panel },
    search: { ...rest, ...(view?.search ?? {}), thread: taskId },
  };
}

/** What a legacy `?task=` becomes: the `{-$taskKey}` segment, and the rest of
 *  the search without it. `null` when there is no `task` to retire. */
export interface LegacyTaskTarget<T> {
  taskKey: string | undefined;
  search: T;
}

/**
 * `?task=<id>` was a card's address before the card had a path of its own. It
 * is accepted as a legacy INPUT exactly the way `sidepanel` accepts its
 * pre-boolean values: read once on entry, then rewritten to the shape the app
 * writes. Nothing writes it any more.
 *
 * It needs no lookup, because `findTaskByKeyOrId` resolves a raw id as
 * happily as a key — so the id it carries is already a valid segment.
 *
 * A `task` that is present but blank still returns a target, so the dead
 * `?task=` leaves the URL instead of sitting there unresolvable forever. An
 * explicit segment wins over it: the path is the address, `task` is the echo.
 *
 * This is the single place a legacy `?task=` is retired — `/$org/$taskId`
 * (above) and the `/$org` resolver both carry it through to `/$org/tasks`
 * rather than translating it themselves.
 */
export function promoteLegacyTaskParam<T extends { task?: string }>(
  taskKey: string | undefined,
  search: T,
): LegacyTaskTarget<Omit<T, "task">> | null {
  if (search.task === undefined) return null;
  const { task, ...rest } = search;
  return { taskKey: taskKey ?? (task.trim() || undefined), search: rest };
}
