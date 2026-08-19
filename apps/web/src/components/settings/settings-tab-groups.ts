/**
 * Settings tab groups — the model behind the merged settings screens.
 *
 * A group is ONE sidebar row that fans out into sibling routes shown as tabs
 * at the top of the page (Members ↔ Roles, Buckets ↔ Synced repos, …). Every
 * route stays exactly where it was, so deep links and bookmarks keep working;
 * only the sidebar collapses.
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
  tabs: SettingsTabDef[];
}

export const SETTINGS_TAB_GROUPS: Record<
  SettingsGroupKey,
  SettingsTabGroupDef
> = {
  connect: {
    key: "connect",
    titleKey: "settings.connectClients.pageTitle",
    tabs: [
      {
        key: "clients",
        labelKey: "settings.subnav.clients",
        to: "/$org/settings/connect",
      },
      {
        key: "api-keys",
        labelKey: "settings.nav.apiKeys",
        to: "/$org/settings/api-keys",
        requires: "api-keys:manage",
      },
    ],
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
        key: "plan",
        labelKey: "settings.subnav.planUsage",
        to: "/$org/settings/billing",
        requires: "members:manage",
      },
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
        key: "synced-repos",
        labelKey: "settings.nav.syncedRepos",
        to: "/$org/settings/synced-repos",
        requires: "file-configs:manage",
      },
    ],
  },
};

/**
 * Every route a merged sidebar row owns. Drives active-state highlighting so
 * opening the Roles tab keeps "Members" lit in the sidebar.
 */
export function groupRoutes(key: SettingsGroupKey): string[] {
  return SETTINGS_TAB_GROUPS[key].tabs.map((tab) => tab.to);
}
