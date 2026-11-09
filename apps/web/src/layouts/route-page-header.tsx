import type { ReactNode } from "react";
import type { BreadcrumbItem } from "@/components/page/breadcrumb-model";
import { useRouterState } from "@tanstack/react-router";
import { LayoutLeft } from "@untitledui/icons";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Page } from "@/components/page";

import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useInSettings } from "@/hooks/use-in-settings";
import { useProjectFirstNav } from "@/hooks/use-preferences";

import { useScopeId } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t";
import { useProjectContext, useVirtualMCPNonBlocking } from "@/sdk";

/** Router adapter for Page.Header. Settings stays independent of thread/runtime providers. */
export function RoutePageHeader({
  actions,
  navigation,
  trailingActions,
}: {
  actions?: ReactNode;
  navigation?: ReactNode;
  trailingActions?: ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const scopeId = useScopeId();
  const project = useVirtualMCPNonBlocking(scopeId);
  const inSettings = useInSettings();
  const projectFirstNav = useProjectFirstNav();
  const page = useRouterState({
    select: (state) =>
      state.matches.findLast((match) => match.staticData.pageTitle)?.staticData,
  });
  const isHome = page?.mainView === "overview";
  const projectTitle = project?.title ?? t("common.loading");
  const title = isHome
    ? // A project's home names the PROJECT, since nothing else on the page
      // does. The org's home is just Home: the org is named in the sidebar's
      // picker, and repeating it as the page title says it twice.
      scopeId
      ? projectTitle
      : t("sidebar.navDestinations.home")
    : // Project-first nav calls the Library Context.
      projectFirstNav && page?.mainView === "files"
      ? t("sidebar.navDestinations.context")
      : t(page?.pageTitle ?? "page.view");
  /** The crumb leaves an app for the project's Overview. */
  const projectLink = {
    to: "/$org/projects/$agentId" as const,
    params: { org: org.slug, agentId: scopeId ?? "" },
  };
  const breadcrumbs: BreadcrumbItem[] = [];
  if (inSettings) {
    breadcrumbs.push({
      key: "settings",
      label: t("sidebar.navDestinations.settings"),
      link: { to: "/$org/settings/general", params: { org: org.slug } },
    });
  } else if (scopeId && !isHome) {
    breadcrumbs.push({
      key: "project",
      label: projectTitle,
      link: projectLink,
    });
  }
  breadcrumbs.push({ key: "page", label: title });
  return (
    <Page.Header
      leading={<SidebarToggleButton />}
      breadcrumbs={breadcrumbs}
      scope={org.name}
      actions={actions}
      navigation={navigation}
      trailingActions={trailingActions}
    />
  );
}

/** Brings a collapsed sidebar back from the leftmost visible panel. Mobile
 *  always shows it; desktop only once project-first nav hid the sidebar. */
export function SidebarToggleButton({
  showOnDesktop = true,
}: {
  showOnDesktop?: boolean;
}) {
  const t = useT();
  const { toggleSidebar } = useSidebar();
  const collapsed = useSidebarCollapsed();
  const projectFirstNav = useProjectFirstNav();
  if (!projectFirstNav) {
    return (
      <ToolbarIconButton
        className="md:hidden"
        onClick={toggleSidebar}
        aria-label={t("layouts.shellControls.toggleSidebar")}
      >
        <LayoutLeft size={16} />
      </ToolbarIconButton>
    );
  }
  const sidebarHidden = showOnDesktop && collapsed;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          className={cn(!sidebarHidden && "md:hidden")}
          onClick={toggleSidebar}
          aria-label={t("page.expandSidebar")}
        >
          <LayoutLeft size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t("page.expandSidebar")}</TooltipContent>
    </Tooltip>
  );
}
