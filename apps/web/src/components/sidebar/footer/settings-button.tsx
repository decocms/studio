/**
 * Settings, in the footer beside the inbox bell: you go there to change
 * something and come back, which is the bell's shape, not a destination's.
 * Always the org's settings; a project's live in its Context.
 *
 * Two forms for the footer's two states, the same pair `inbox.tsx` keeps.
 */

import { Link } from "@tanstack/react-router";
import { Settings02 } from "@untitledui/icons";
import {
  SidebarMenuButton,
  useSidebar,
} from "@decocms/ui/components/sidebar.tsx";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { SETTINGS_DESTINATION } from "@/components/sidebar/nav-destinations";
import { SidebarFooterIcon } from "./icon-slot";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useProjectContext } from "@/sdk";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

function useSettingsLink() {
  const { org } = useProjectContext();
  const { setOpenMobile } = useSidebar();
  return {
    to: "/$org/settings",
    params: { org: org.slug },
    onClick: () => {
      track("nav_destination_clicked", {
        destination: SETTINGS_DESTINATION,
        target: "org",
      });
      setOpenMobile(false);
    },
  } as const;
}

/** Sized and styled as `InboxIconButton`; the two are one control strip. */
export function SettingsIconButton() {
  const t = useT();
  const link = useSettingsLink();
  const label = t("sidebar.navDestinations.settings");

  return (
    <Link
      {...link}
      aria-label={label}
      title={label}
      className="relative flex size-7 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
      data-tour={LAYOUT_TOUR_ANCHORS.settings}
    >
      <Settings02 size={15} />
    </Link>
  );
}

/** Full-width row, for the collapsed rail where there is no account row to sit
 *  beside. */
export function SettingsFullButton() {
  const t = useT();
  const collapsed = useSidebarCollapsed();
  const link = useSettingsLink();
  const label = t("sidebar.navDestinations.settings");

  return (
    <SidebarMenuButton
      asChild
      tooltip={collapsed ? label : undefined}
      data-tour={LAYOUT_TOUR_ANCHORS.settings}
    >
      <Link {...link} aria-label={label}>
        <SidebarFooterIcon>
          <Settings02 size={16} />
        </SidebarFooterIcon>
        <span>{label}</span>
      </Link>
    </SidebarMenuButton>
  );
}
