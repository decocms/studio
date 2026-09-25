import type { ReactNode } from "react";
import type { BreadcrumbItem } from "@/components/page/breadcrumb-model";
import { useRouterState } from "@tanstack/react-router";
import { LayoutLeft } from "@untitledui/icons";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import { Page } from "@/components/page";

import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useInSettings } from "@/hooks/use-in-settings";

import { useScopeId } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t";
import { useProjectContext, useVirtualMCPNonBlocking } from "@/sdk";

/** Router adapter for Page.Header. Settings stays independent of thread/runtime providers. */
export function RoutePageHeader({
  actions,
  navigation,
}: {
  actions?: ReactNode;
  navigation?: ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const scopeId = useScopeId();
  const project = useVirtualMCPNonBlocking(scopeId);
  const inSettings = useInSettings();
  const { toggleSidebar } = useSidebar();
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
    : t(page?.pageTitle ?? "page.view");

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
      link: {
        to: "/$org/projects/$agentId",
        params: { org: org.slug, agentId: scopeId },
      },
    });
  }
  breadcrumbs.push({ key: "page", label: title });
  return (
    <Page.Header
      leading={
        <ToolbarIconButton
          className="md:hidden"
          onClick={toggleSidebar}
          aria-label={t("layouts.shellControls.toggleSidebar")}
        >
          <LayoutLeft size={16} />
        </ToolbarIconButton>
      }
      breadcrumbs={breadcrumbs}
      actions={actions}
      navigation={navigation}
    />
  );
}
