import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, LayoutLeft } from "@untitledui/icons";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import { Page } from "@/components/page";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useInSettings } from "@/hooks/use-in-settings";
import { useCompactPageLayout } from "@/hooks/use-preferences";
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
  const compact = useCompactPageLayout();
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
  const separator = (
    <ChevronRight
      size={12}
      className="shrink-0 text-muted-foreground/60"
      aria-hidden="true"
    />
  );
  if (!compact) return null;
  return (
    <Page.Header
      title={title}
      leading={
        <ToolbarIconButton
          className="md:hidden"
          onClick={toggleSidebar}
          aria-label={t("layouts.shellControls.toggleSidebar")}
        >
          <LayoutLeft size={16} />
        </ToolbarIconButton>
      }
      breadcrumbs={
        // The org is never a crumb: it is the whole app, so naming it says
        // nothing. A trail exists only where there is something ABOVE the
        // page — the project you are in, or Settings.
        (inSettings || (scopeId && !isHome)) && (
          <div className="hidden min-w-0 shrink items-center gap-2 text-sm text-muted-foreground @min-xl/panel-header:flex">
            {inSettings ? (
              <>
                <Link
                  to="/$org/settings/general"
                  params={{ org: org.slug }}
                  className="truncate hover:text-foreground"
                >
                  {t("sidebar.navDestinations.settings")}
                </Link>
                {separator}
              </>
            ) : scopeId && !isHome ? (
              <>
                <Link
                  to="/$org/projects/$agentId"
                  params={{ org: org.slug, agentId: scopeId }}
                  className="max-w-40 truncate hover:text-foreground"
                >
                  {projectTitle}
                </Link>
                {separator}
              </>
            ) : null}
          </div>
        )
      }
      actions={actions}
      navigation={navigation}
    />
  );
}
