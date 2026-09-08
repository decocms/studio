/** Settings tab groups — ONE sidebar row fanning out into sibling routes shown
 *  as tabs (Members ↔ Roles, Buckets ↔ Synced repos, …). Routes stay put, so
 *  deep links keep working; only the sidebar collapses. A group may declare NO
 *  tabs — Connect, whose API keys tab is now a section on its own page — and
 *  still lives here, because the page chrome reads its title from this file.
 *
 * Both the sidebar (`settings-layout.tsx`) and the in-page tab strip
 * (`settings-subnav.tsx`) read this file, so a row and its tabs can never
 * disagree about which routes belong together.
 */

import type { CapabilityId } from "@/hooks/use-capability";
import type { TranslationKey } from "@/i18n/use-t.ts";

export type SettingsGroupKey = "connect" | "members" | "billing" | "storage";

export interface SettingsTabDef {
  /** Stable id for React keys and analytics — never localized. */
  key: string;
  labelKey: TranslationKey;
  /** `$org`-templated route path, same shape as the sidebar's `to`. */
  to: string;
  /** Capability required to see this tab. Omitted = visible to every member. */
  requires?: CapabilityId;
  /** Restrict to privileged built-in roles (owner/admin), like the sidebar's flag. */
  privilegedOnly?: boolean;
  /** Only shown for orgs that own a legacy deco.cx site — nothing to bill otherwise. */
  requiresOwnedSites?: boolean;
}

export interface SettingsTabGroupDef {
  key: SettingsGroupKey;
  /** Page heading shown above the tabs, for every tab in the group. */
  titleKey: TranslationKey;
  /** Sibling routes shown as tabs. Empty for a group that is a single page. */
  tabs: SettingsTabDef[];
  /**
   * Routes the sidebar row owns without tabbing to them: a page that was
   * folded into a sibling still answers its old URL, and a bookmark of it
   * should still light the row up.
   */
  ownedRoutes?: string[];
}

export const SETTINGS_TAB_GROUPS: Record<
  SettingsGroupKey,
  SettingsTabGroupDef
> = {
  connect: {
    key: "connect",
    titleKey: "settings.connectClients.pageTitle",
    tabs: [],
    ownedRoutes: ["/$org/settings/api-keys"],
  },
  members: {
    key: "members",
    titleKey: "orgs.members.title",
    tabs: [
      {
        key: "members",
        labelKey: "orgs.members.title",
        to: "/$org/settings/members",
        requires: "members:manage",
      },
      {
        key: "roles",
        labelKey: "settings.roles.pageTitle",
        to: "/$org/settings/roles",
        privilegedOnly: true,
      },
    ],
  },
  billing: {
    key: "billing",
    titleKey: "settings.nav.billing",
    tabs: [
      {
        key: "ai-providers",
        labelKey: "settings.nav.aiProviders",
        to: "/$org/settings/ai-providers",
        requires: "ai-providers:manage",
      },
      {
        key: "infra",
        labelKey: "settings.subnav.infrastructure",
        to: "/$org/settings/infra-billing",
        requires: "members:manage",
        requiresOwnedSites: true,
      },
    ],
  },
  storage: {
    key: "storage",
    titleKey: "settings.nav.storage",
    tabs: [
      {
        key: "buckets",
        labelKey: "settings.nav.buckets",
        to: "/$org/settings/buckets",
        requires: "file-configs:manage",
      },
      {
        key: "repositories",
        labelKey: "settings.nav.repositories",
        to: "/$org/settings/repositories",
        requires: "file-configs:manage",
      },
      {
        key: "synced-repos",
        labelKey: "settings.nav.syncedRepos",
        to: "/$org/settings/synced-repos",
        requires: "file-configs:manage",
      },
    ],
  },
};

/** Every route a merged row owns beyond its own `to`, so opening Roles keeps
 *  "Members" lit — and so does deep-linking a route a page absorbed. */
export function groupRoutes(key: SettingsGroupKey): string[] {
  const group = SETTINGS_TAB_GROUPS[key];
  return [...group.tabs.map((tab) => tab.to), ...(group.ownedRoutes ?? [])];
}

/** Whether the group fans out at all. A tabless group is one page: its row
 *  keeps its own route and, unlike a group gated away, never disappears. */
export function hasTabs(key: SettingsGroupKey): boolean {
  return SETTINGS_TAB_GROUPS[key].tabs.length > 0;
}
