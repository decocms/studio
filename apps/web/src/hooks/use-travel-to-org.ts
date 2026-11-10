/** Switching org from the rail or the ⌘K palette: bring the org back onto the
 *  rail if it was hidden, record it as recent, and go to its home. */

import { useNavigate } from "@tanstack/react-router";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useRecentOrgs } from "@/hooks/use-recent-orgs";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import {
  EMPTY_RAIL_ORG_PREFS,
  readRailOrgPrefs,
  showRailOrg,
  type RailOrgPrefs,
} from "@/lib/rail-org-prefs";

export function useTravelToOrg(): (
  slug: string,
  /** The slugs the rail shows now. An org already among them keeps the rail
   *  as it is; one picked from search rolls the oldest off by recency. */
  railSlugs?: readonly string[],
) => void {
  const navigate = useNavigate();
  const { remember } = useRecentOrgs();
  const [, setPrefs] = useLocalStorage<RailOrgPrefs>(
    LOCALSTORAGE_KEYS.railOrgPrefs(),
    EMPTY_RAIL_ORG_PREFS,
  );

  return (slug, railSlugs) => {
    const onRail = railSlugs?.includes(slug) ?? false;
    setPrefs((prev) => showRailOrg(readRailOrgPrefs(prev), slug));
    remember(slug, onRail ? railSlugs : undefined);
    /** A view transition, so the rail's marks slide to their new places. */
    navigate({ to: "/$org/home", params: { org: slug }, viewTransition: true });
  };
}
