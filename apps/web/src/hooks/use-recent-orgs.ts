/**
 * The organizations you switched to last. Written at the SWITCH, since
 * observing the route would mean writing during render.
 *
 * So an org reached by deep link is not recorded until you leave and return;
 * `railOrgs` covers that by always drawing the current org.
 *
 * Backed by `useLocalStorage` (TanStack-Query-backed), so the rail and the
 * palette re-render together with no bus in between.
 */

import { useLocalStorage } from "./use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { pushRecentOrg } from "@/lib/recent-orgs";

const EMPTY: string[] = [];

export function useRecentOrgs(): {
  recent: string[];
  remember: (slug: string, keep?: readonly string[]) => void;
} {
  const [recent, setRecent] = useLocalStorage<string[]>(
    LOCALSTORAGE_KEYS.recentOrgs(),
    EMPTY,
  );

  return {
    /** A value from an older build must not crash the rail. */
    recent: Array.isArray(recent) ? recent : EMPTY,
    remember: (slug, keep) =>
      setRecent((prev) =>
        pushRecentOrg(Array.isArray(prev) ? prev : [], slug, undefined, keep),
      ),
  };
}
