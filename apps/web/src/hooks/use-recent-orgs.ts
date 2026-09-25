/**
 * The organizations you switched to last, and the one way to add to them.
 *
 * Written at the SWITCH — the rail's mark and the search palette's row are
 * both explicit "take me there" clicks, so that is the event. Observing the
 * route instead would mean writing during render, and `useEffect` is banned
 * here.
 *
 * One consequence worth knowing: an org reached by deep link is not recorded
 * until you navigate away from and back to it. `railOrgs` covers the visible
 * half of that by always drawing the current org whether or not it is in the
 * history.
 *
 * Backed by `useLocalStorage`, which is TanStack-Query-backed, so the rail and
 * the palette read one key from different corners of the tree and re-render
 * together with no bus in between.
 */

import { useLocalStorage } from "./use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { pushRecentOrg } from "@/lib/recent-orgs";

const EMPTY: string[] = [];

export function useRecentOrgs(): {
  recent: string[];
  remember: (slug: string) => void;
} {
  const [recent, setRecent] = useLocalStorage<string[]>(
    LOCALSTORAGE_KEYS.recentOrgs(),
    EMPTY,
  );

  return {
    /** A value written by an older build (or by hand) must not crash the rail
     *  that draws it. */
    recent: Array.isArray(recent) ? recent : EMPTY,
    remember: (slug) =>
      setRecent((prev) => pushRecentOrg(Array.isArray(prev) ? prev : [], slug)),
  };
}
