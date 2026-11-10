import { useSyncExternalStore } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useInSettings } from "@/hooks/use-in-settings";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { useScopeId } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t";
import { useRouteThreadId } from "@/layouts/thread-route";
import { useProjectContext, useVirtualMCPNonBlocking } from "@/sdk";
import type { VirtualMCPEntity } from "@/sdk";

export interface CurrentView {
  /** The project the page belongs to, when it belongs to one. */
  project: VirtualMCPEntity | null;
  /** The page's own name: "Site Editor", "Tasks", or the project on its home. */
  title: string;
  isHome: boolean;
  inSettings: boolean;
}

/** What the person is looking at, named the way the page header names it. */
export function useCurrentView(): CurrentView {
  const t = useT();
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
    ? // A project's home names the PROJECT; the org's home is just Home.
      scopeId
      ? projectTitle
      : t("sidebar.navDestinations.home")
    : projectFirstNav && page?.mainView === "files"
      ? t("sidebar.navDestinations.context")
      : t(page?.pageTitle ?? "page.view");
  return { project: scopeId ? project : null, title, isHome, inSettings };
}

/** `org:thread:view` of the view the person took out of the chat's context. */
let dismissedKey: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The view the chat tells the agent about, or null once dismissed. Dismissal
 * holds for that view in that chat: moving to another page brings it back.
 */
export function useChatViewContext():
  | (CurrentView & {
      dismiss: () => void;
    })
  | null {
  const view = useCurrentView();
  const { org } = useProjectContext();
  const threadId = useRouteThreadId();
  const dismissed = useSyncExternalStore(
    subscribe,
    () => dismissedKey,
    () => dismissedKey,
  );
  if (view.inSettings) return null;
  const key = `${org.id}:${threadId ?? ""}:${view.project?.id ?? ""}:${view.title}`;
  if (key === dismissed) return null;
  return {
    ...view,
    dismiss: () => {
      dismissedKey = key;
      for (const listener of listeners) listener();
    },
  };
}
