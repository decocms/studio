import type { ReactNode } from "react";
import type { BreadcrumbItem } from "@/components/page/breadcrumb-model";
import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutLeft, MessageCircle01, XClose } from "@untitledui/icons";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { Page } from "@/components/page";

import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useAppTakeover } from "@/hooks/use-app-takeover";
import { useInSettings } from "@/hooks/use-in-settings";
import { useOptionalChatLayout } from "@/components/chat-layout";

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
  const takeover = useAppTakeover();
  const chatLayout = useOptionalChatLayout();
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
  /** The crumb is the way out of an app, so it lands on the project as the
   *  reader knows it: its one screen. Sending them to the scoped workspace
   *  instead is how someone loses the sidebar and cannot get it back. */
  const projectLink = {
    to: "/$org/projects" as const,
    params: { org: org.slug },
    search: { project: scopeId ?? undefined },
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
  /** An app took the whole screen (no nav sidebar beside it — see
   *  `useAppTakeover`), so the breadcrumb crumb is its only way out. That is
   *  one click too many to be the ONLY affordance: a launched app reads as a
   *  window, and a window closes from its own corner. */
  const closeAction = takeover && scopeId && (
    <IconButton label={t("projects.flat.close")} asChild>
      <Link {...projectLink}>
        <XClose size={16} />
      </Link>
    </IconButton>
  );
  /** An app takes the sidebar's place, so its own thread toggle — normally in
   *  the sidebar header — goes with it. Without this, an app with the chat
   *  closed has no way back into it. */
  const chatToggle = takeover && chatLayout && (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={t(
            chatLayout.threadOpen ? "page.closeThread" : "page.openThread",
          )}
          aria-pressed={chatLayout.threadOpen}
          active={chatLayout.threadOpen}
          onClick={chatLayout.toggleThread}
        >
          <MessageCircle01 size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t(chatLayout.threadOpen ? "page.closeThread" : "page.openThread")}
      </TooltipContent>
    </Tooltip>
  );
  return (
    <Page.Header
      leading={
        <>
          <ToolbarIconButton
            className="md:hidden"
            onClick={toggleSidebar}
            aria-label={t("layouts.shellControls.toggleSidebar")}
          >
            <LayoutLeft size={16} />
          </ToolbarIconButton>
          {chatToggle}
        </>
      }
      breadcrumbs={breadcrumbs}
      actions={actions}
      trailingActions={closeAction}
      navigation={navigation}
    />
  );
}
