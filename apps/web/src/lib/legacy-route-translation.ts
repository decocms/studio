/**
 * Legacy `/$org/$taskId` → first-class-navigation URL translation.
 *
 * Every surface used to live on one thread route, and the sidebar's
 * destinations were just `?main=<tabId>` overlays. A destination is a real path
 * segment now, so the legacy route (which stays mounted forever, for every
 * bookmark and shared link ever minted) translates itself on entry.
 *
 * The governing rule: **path = which page, search = how that page is laid out.**
 * So `virtualmcpid` is promoted to the `{-$project}` path segment, the thread id
 * moves from the path to `?thread=`, and `main` / `sidepanel` stay in search —
 * `main` is panel *visibility* (`main=0` means closed), which no path segment
 * can express.
 *
 * This is a **pure** function of `(org, taskId, search)`: no fetch, no thread
 * lookup, no React. It can be pure because `threads.virtual_mcp_id` is NOT NULL
 * — one agent per thread — so `/$org/chat?thread=<id>` resolves its own project
 * from the row the chat route loads anyway. The translator never needs to know
 * which agent owns the thread, which is what keeps the redirect instant and
 * impossible to serve stale.
 *
 * The four destination-backed `main` values drop the project **deliberately**:
 * today `main=board` on a coding agent shows the ORG-WIDE board (see the
 * docblock at `components/sidebar/nav-destinations.tsx`), so carrying the
 * project forward would invent a filter the old URL never had. `main` itself is
 * dropped there too — the path now says which page this is.
 *
 * `main=connect-sources` is an overlay tab with no destination route of its own,
 * so it falls through to the chat route with `main` carried verbatim, exactly
 * like a per-agent view (`preview` / `code` / `content` / …).
 */

/** The legacy `/$org/$taskId` search params this translator reads. Every other
 *  key (`sidepanel`, `task`, `connect`, board filters, …) is carried through
 *  verbatim. */
export interface LegacyThreadSearch {
  /** Legacy agent selector. Promoted to the `{-$project}` path segment. */
  virtualmcpid?: string;
  /** Active main-panel view, or the `0` closed sentinel. */
  main?: string | 0;
  [key: string]: unknown;
}

/** Full paths of the destination routes this translator can land on. */
export type LegacyThreadDestination =
  | "/$org/chat/{-$project}"
  | "/$org/tasks/{-$project}"
  | "/$org/reports"
  | "/$org/library"
  | "/$org/home";

/** Shaped for TanStack's `navigate()` / `<Navigate />`: `{ to, params, search }`. */
export interface LegacyThreadTarget {
  to: LegacyThreadDestination;
  params: { org: string; project: string | undefined };
  search: Record<string, unknown> & { thread: string };
}

/** `main` values that became their own destination route. The project segment
 *  and `main` are both dropped for these — see the module docblock. */
const DESTINATION_BY_MAIN_TAB: Readonly<
  Record<string, LegacyThreadDestination | undefined>
> = {
  board: "/$org/tasks/{-$project}",
  files: "/$org/library",
  reports: "/$org/reports",
  overview: "/$org/home",
};

export function translateLegacyThreadRoute(args: {
  org: string;
  taskId: string;
  search?: LegacyThreadSearch | null;
}): LegacyThreadTarget {
  const { org, taskId } = args;
  const { virtualmcpid, main, ...rest } = args.search ?? {};

  const destination =
    typeof main === "string" ? DESTINATION_BY_MAIN_TAB[main] : undefined;

  if (destination) {
    return {
      to: destination,
      params: { org, project: undefined },
      search: { ...rest, thread: taskId },
    };
  }

  /** A blank agent id would interpolate into an empty segment, so it reads as
   *  "no project" (the Super Agent), same as an absent one. */
  const project = virtualmcpid?.trim() ? virtualmcpid : undefined;

  return {
    to: "/$org/chat/{-$project}",
    params: { org, project },
    search:
      main === undefined
        ? { ...rest, thread: taskId }
        : { ...rest, main, thread: taskId },
  };
}
