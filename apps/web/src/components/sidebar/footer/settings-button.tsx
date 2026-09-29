/**
 * Settings, in the footer beside the inbox bell: you go there to change
 * something and come back, which is the bell's shape, not a destination's.
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
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { useScopeId } from "@/hooks/use-project-scope";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useProjectContext } from "@/sdk";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

/** Scoped it opens the PROJECT's settings, which live in a session whose id is
 *  unknown at render time — so scoped is a button, unscoped an anchor. */
function useSettingsTarget() {
  const { org } = useProjectContext();
  const scopeId = useScopeId();
  const navigateToAgent = useNavigateToAgent();

  return {
    scopeId,
    orgLink: { to: "/$org/settings", params: { org: org.slug } } as const,
    open: () => {
      track("nav_destination_clicked", {
        destination: SETTINGS_DESTINATION,
        target: scopeId ? "project" : "org",
      });
      if (scopeId) navigateToAgent(scopeId, { panel: "settings" });
    },
  };
}

/** Sized and styled as `InboxIconButton`; the two are one control strip. */
export function SettingsIconButton() {
  const t = useT();
  const { scopeId, orgLink, open } = useSettingsTarget();
  const label = t("sidebar.navDestinations.settings");
  const className =
    "relative flex size-7 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground";

  if (scopeId) {
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={open}
        className={className}
        data-tour={LAYOUT_TOUR_ANCHORS.settings}
      >
        <Settings02 size={15} />
      </button>
    );
  }

  return (
    <Link
      {...orgLink}
      aria-label={label}
      title={label}
      onClick={open}
      className={className}
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
  const { setOpenMobile } = useSidebar();
  const { scopeId, orgLink, open } = useSettingsTarget();
  const label = t("sidebar.navDestinations.settings");

  const body = (
    <>
      <SidebarFooterIcon>
        <Settings02 size={16} />
      </SidebarFooterIcon>
      <span>{label}</span>
    </>
  );
  const onSelect = () => {
    open();
    setOpenMobile(false);
  };

  if (scopeId) {
    return (
      <SidebarMenuButton
        tooltip={collapsed ? label : undefined}
        aria-label={label}
        onClick={onSelect}
        data-tour={LAYOUT_TOUR_ANCHORS.settings}
      >
        {body}
      </SidebarMenuButton>
    );
  }

  return (
    <SidebarMenuButton
      asChild
      tooltip={collapsed ? label : undefined}
      data-tour={LAYOUT_TOUR_ANCHORS.settings}
    >
      <Link {...orgLink} aria-label={label} onClick={onSelect}>
        {body}
      </Link>
    </SidebarMenuButton>
  );
}
