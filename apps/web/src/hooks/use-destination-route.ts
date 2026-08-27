/**
 * The destination routes, addressed by their full path.
 *
 * Path = which page, search = how that page is laid out. So "which destination
 * am I on" is answered by the matched leaf route, never by `?main=` — that is
 * panel visibility and can read `0` (closed) on any page.
 *
 * The strings here are the `path` values registered in `router.tsx`; TanStack's
 * `fullPath` on a match is exactly that path with the pathless layout ids
 * elided, so a leaf match on `/$org/home` compares equal to `DESTINATION_ROUTE.home`.
 * They are typed `as const` and fed straight to `<Link to>` / `navigate({ to })`,
 * which means a rename in `router.tsx` is a compile error here.
 */

import { useRouterState } from "@tanstack/react-router";

export const DESTINATION_ROUTE = {
  home: "/$org/home",
  chat: "/$org/chat/{-$project}",
  tasks: "/$org/tasks/{-$project}",
  reports: "/$org/reports",
  library: "/$org/library",
  /** The `/$org` resolver. Transiently matched before it redirects, so Home
   *  highlights there instead of leaving the list blank on cold entry. */
  orgIndex: "/$org/",
  /** The legacy thread route, mounted forever. */
  legacyThread: "/$org/$taskId",
} as const;

export type DestinationRoutePath =
  (typeof DESTINATION_ROUTE)[keyof typeof DESTINATION_ROUTE];

/** The matched leaf route's full path, e.g. `"/$org/tasks/{-$project}"`. */
export function useLeafRoutePath(): string {
  return useRouterState({
    select: (state) => state.matches.at(-1)?.fullPath ?? "",
  });
}
