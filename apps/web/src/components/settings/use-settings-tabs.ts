/**
 * Which tabs of each settings group the current member may open.
 *
 * One hook for every group so the sidebar can ask "does this row have anything
 * behind it?" without calling a hook per group. A merged row is visible exactly
 * when at least one of its tabs is — the row has no gate of its own.
 */

import { useCapabilities } from "@/hooks/use-capability";
import { useOwnedSites } from "@/hooks/use-infra-billing";
import {
  SETTINGS_TAB_GROUPS,
  type SettingsGroupKey,
  type SettingsTabDef,
} from "./settings-tab-groups";

export type VisibleSettingsTabs = Record<SettingsGroupKey, SettingsTabDef[]>;

/**
 * Mirrors the sidebar's optimistic-while-loading rule: show everything until
 * capabilities resolve, so owners never see the tab strip flicker.
 */
export function useVisibleSettingsTabs(): VisibleSettingsTabs {
  const { capabilities, isPrivileged, loading, error } = useCapabilities();
  const { sites, isLoading: sitesLoading } = useOwnedSites();
  const ownsSites = sites.length > 0;

  const canSee = (tab: SettingsTabDef) => {
    // Same optimistic-while-loading rule as capabilities: don't hide mid-fetch.
    if (tab.requiresOwnedSites && !ownsSites && !sitesLoading) return false;
    if (loading || error) return true;
    if (tab.privilegedOnly) return isPrivileged;
    if (!tab.requires) return true;
    return isPrivileged || capabilities[tab.requires];
  };

  return Object.fromEntries(
    Object.values(SETTINGS_TAB_GROUPS).map((group) => [
      group.key,
      group.tabs.filter(canSee),
    ]),
  ) as VisibleSettingsTabs;
}
