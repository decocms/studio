/** WHICH rows the settings sidebar has, and who may see them. The model only —
 *  `settings-sidebar.tsx` renders it. Rows that own sibling routes (Connect ⊃
 *  API Keys, Billing ⊃ AI Providers, …) declare a `group` and surface those
 *  routes as in-page tabs; see `settings-tab-groups.ts`. */

import type { ReactNode } from "react";
import {
  type LinkProps,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import {
  BarChart10,
  Building02,
  Columns03,
  Stars01,
  CreditCard01,
  HardDrive,
  Key01,
  LinkExternal01,
  Lock01,
  PackageCheck,
  User01,
  Users03,
  Zap,
  ZapSquare,
} from "@untitledui/icons";
import {
  groupRoutes,
  hasTabs,
  type SettingsGroupKey,
} from "@/components/settings/settings-tab-groups";
import { useVisibleSettingsTabs } from "@/components/settings/use-settings-tabs";
import { type CapabilityId, useCapabilities } from "@/hooks/use-capability";
import { usePendingJoinRequests } from "@/hooks/use-join-requests";
import { useT } from "@/i18n/use-t.ts";

/** A route the sidebar can point a row at. `settings-tab-groups.ts` stores the
 *  same routes as plain `$org`-templated strings so the sidebar and the in-page
 *  tab strip share ONE list; the router wants the literal union. This type is
 *  where the two meet. */
type SettingsPath = NonNullable<LinkProps["to"]>;

export interface SettingsNavItem {
  key: string;
  label: string;
  icon: ReactNode;
  to: SettingsPath;
  /** Tab group this row fans out into. Visible when any of its tabs is. */
  group?: SettingsGroupKey;
  /** Capability required to see this item. Omitted = visible to every member. */
  requires?: CapabilityId;
  /** Restrict to privileged built-in roles (owner/admin). For screens backed
   *  by owner/admin-only APIs (e.g. role management). */
  privilegedOnly?: boolean;
  /** Count for a small red notification dot on the item (omit / 0 = none). */
  badge?: number;
}

export interface SettingsNavGroup {
  /** Stable id for React keys and analytics — never localized. */
  key: string;
  /** Group heading. Empty for the unlabeled account group at the top. */
  label: string;
  /** Rendered behind a disclosure, closed unless it holds the open page. */
  collapsible?: boolean;
  items: SettingsNavItem[];
}

/** Your account, then the three groups of org screens people work in, then
 *  everything rare behind a collapsed "Advanced". */
export function useSettingsSidebarGroups(): SettingsNavGroup[] {
  const t = useT();
  const { capabilities, isPrivileged, loading, error } = useCapabilities();
  const joinRequestCount = usePendingJoinRequests().length;
  const visibleTabs = useVisibleSettingsTabs();

  const groups: SettingsNavGroup[] = [
    {
      key: "account",
      label: "",
      items: [
        {
          key: "profile",
          label: t("settings.nav.profile"),
          icon: <User01 size={14} />,
          to: "/$org/settings/profile",
        },
      ],
    },
    {
      key: "organization",
      label: t("settings.nav.organization"),
      items: [
        {
          key: "general",
          label: t("settings.nav.general"),
          icon: <Building02 size={14} />,
          to: "/$org/settings/general",
          requires: "org:manage",
        },
        {
          key: "billing",
          label: t("settings.nav.billing"),
          icon: <CreditCard01 size={14} />,
          to: "/$org/settings/ai-providers",
          group: "billing",
        },
        {
          key: "connect",
          label: t("settings.nav.connect"),
          icon: <LinkExternal01 size={14} />,
          to: "/$org/settings/connect",
          group: "connect",
        },
        {
          key: "tasks",
          label: t("settings.nav.tasks"),
          icon: <Columns03 size={14} />,
          to: "/$org/settings/task-board",
          requires: "org:manage",
        },
      ],
    },
    {
      key: "build",
      label: t("settings.nav.build"),
      items: [
        {
          key: "connections",
          label: t("settings.nav.connections"),
          icon: <ZapSquare size={14} />,
          to: "/$org/settings/connections",
        },
        {
          key: "agents",
          label: t("settings.nav.agents"),
          icon: <Users03 size={14} />,
          to: "/$org/settings/agents",
        },
        {
          key: "automations",
          label: t("settings.nav.automations"),
          icon: <Zap size={14} />,
          to: "/$org/settings/automations",
          requires: "automations:manage",
        },
        {
          key: "skills",
          label: t("settings.nav.skills"),
          icon: <Stars01 size={14} />,
          to: "/$org/settings/skills",
        },
      ],
    },
    {
      key: "manage",
      label: t("settings.nav.manage"),
      items: [
        {
          key: "monitor",
          label: t("settings.nav.monitor"),
          icon: <BarChart10 size={14} />,
          to: "/$org/settings/monitor",
          requires: "monitoring:view",
        },
        {
          key: "members",
          label: t("settings.nav.members"),
          icon: <Users03 size={14} />,
          to: "/$org/settings/members",
          group: "members",
          badge: joinRequestCount,
        },
      ],
    },
    {
      key: "advanced",
      label: t("settings.nav.advanced"),
      collapsible: true,
      items: [
        {
          key: "secrets",
          label: t("settings.nav.secrets"),
          icon: <Key01 size={14} />,
          to: "/$org/settings/secrets",
          requires: "secrets:manage",
        },
        {
          key: "storage",
          label: t("settings.nav.storage"),
          icon: <HardDrive size={14} />,
          to: "/$org/settings/buckets",
          group: "storage",
        },
        {
          key: "store",
          label: t("settings.nav.store"),
          icon: <PackageCheck size={14} />,
          to: "/$org/settings/store",
          requires: "registry:manage",
        },
        {
          key: "sso",
          label: t("settings.nav.security"),
          icon: <Lock01 size={14} />,
          to: "/$org/settings/sso",
          requires: "org:manage",
        },
      ],
    },
  ];

  /** While capabilities load — or if the lookup errored — show every item
   *  optimistically. This avoids a flicker for the common privileged case and
   *  ensures a transient failure never hides nav from owners/admins. Once
   *  resolved, hide items the member's role can't open and drop any group left
   *  empty. Items without a `requires` (Profile, plugin items) are always
   *  shown. */
  return groups
    .map((group) => ({
      ...group,
      items: group.items.flatMap((item) => {
        if (item.group) {
          /** Route the row at the first tab this member can open. A tabless
           *  group (Connect) has nothing to pick, so the row keeps its own
           *  `to`; a group gated away entirely is empty, so it drops. */
          const [firstTab] = visibleTabs[item.group];
          if (!firstTab) {
            return hasTabs(item.group) ? [] : [item];
          }
          return [{ ...item, to: firstTab.to as SettingsPath }];
        }
        if (loading || error) return [item];
        if (item.privilegedOnly) return isPrivileged ? [item] : [];
        if (!item.requires) return [item];
        return isPrivileged || capabilities[item.requires] ? [item] : [];
      }),
    }))
    .filter((group) => group.items.length > 0);
}

/** Resolves `$org`-templated `to` paths against the current org/pathname.
 *  Matching is segment-exact, so `/settings/connect` doesn't also light up on
 *  `/settings/connections` while a nested `/settings/store/registry` still
 *  does. */
export function useIsActiveSettingsPath() {
  const { org } = useParams({ from: "/shell/$org" });
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const matches = (to: string) => {
    const resolved = to.replace("$org", org);
    return pathname === resolved || pathname.startsWith(`${resolved}/`);
  };

  const isActive = (item: SettingsNavItem) =>
    [item.to, ...(item.group ? groupRoutes(item.group) : [])].some(matches);

  return { org, isActive };
}
