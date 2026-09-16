import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, LayoutLeft } from "@untitledui/icons";
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
  const titleKey = useRouterState({
    select: (state) =>
      state.matches.findLast((match) => match.staticData.pageTitle)?.staticData
        .pageTitle,
  });
  const separator = (
    <ChevronRight
      size={12}
      className="shrink-0 text-muted-foreground/60"
      aria-hidden="true"
    />
  );
  return (
    <Page.Header
      title={t(titleKey ?? "page.view")}
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
        <nav
          aria-label={t("page.breadcrumbs")}
          className="hidden min-w-0 shrink items-center gap-2 text-sm text-muted-foreground sm:flex"
        >
          <Link
            to="/$org/home"
            params={{ org: org.slug }}
            className="max-w-32 truncate hover:text-foreground"
          >
            {org.name}
          </Link>
          {separator}
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
          ) : scopeId ? (
            <>
              <Link
                to="/$org/projects/$agentId"
                params={{ org: org.slug, agentId: scopeId }}
                className="max-w-40 truncate hover:text-foreground"
              >
                {project?.title ?? t("page.overview")}
              </Link>
              {separator}
            </>
          ) : null}
        </nav>
      }
      actions={actions}
      navigation={navigation}
    />
  );
}
