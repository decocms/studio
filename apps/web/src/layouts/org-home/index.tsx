/**
 * Org landing (`/$org`) — a resolver, never a page.
 *
 * It picks a DESTINATION and no thread at all: cold entry must not mint a
 * conversation nobody asked for. In order: a `?main=` deep link that now has a
 * real path of its own, then the org's main agent (`useMainAgentId`), then
 * Home.
 */
import { Navigate, useSearch } from "@tanstack/react-router";
import { useProjectContext } from "@/sdk";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";

/**
 * `?main=` values that became destinations of their own. A deep link minted
 * before the promotion (a shared `/$org?main=board&task=…`) keeps working by
 * landing on the path instead of the overlay — the same table
 * `translateLegacyThreadRoute` applies to `/$org/$taskId`.
 */
const DESTINATION_BY_MAIN_TAB = {
  board: DESTINATION_ROUTE.tasks,
  files: DESTINATION_ROUTE.library,
  reports: DESTINATION_ROUTE.reports,
  overview: DESTINATION_ROUTE.home,
} as const;

type PromotedMainTab = keyof typeof DESTINATION_BY_MAIN_TAB;

function isPromotedMainTab(main: string | undefined): main is PromotedMainTab {
  return !!main && main in DESTINATION_BY_MAIN_TAB;
}

export default function OrgHome() {
  const { org } = useProjectContext();
  /** `main` carries a legacy deep link into a view (e.g. `board` = Tasks,
   *  `files` = Library) through the redirect. The four destination-backed
   *  values land on their own page below; every other value rides along to the
   *  chat route verbatim, where `<LegacyMainRedirect />` retires it into the
   *  `{-$panel}` segment — the single place that translation lives. `task`
   *  rides along to the board only, which is the one destination that retires
   *  it into its path. */
  const { connect, siteUrl, main, task, sidepanel, virtualmcpid } = useSearch({
    strict: false,
  }) as {
    connect?: string;
    siteUrl?: string;
    main?: string;
    task?: string;
    sidepanel?: boolean;
    virtualmcpid?: string;
  };

  // A promoted `?main=` outranks everything: the URL already says which page.
  if (isPromotedMainTab(main)) {
    return (
      <Navigate
        to={DESTINATION_BY_MAIN_TAB[main]}
        params={{ org: org.slug }}
        search={{ connect, siteUrl, task, sidepanel }}
        replace
      />
    );
  }

  /** The scope the URL NAMES, and nothing else. This resolver is where
   *  cross-org travel lands (`travelTo` in the picker navigates to `/$org`
   *  with the picked project), so it forwards that scope and otherwise falls
   *  through to the org home — which is the page worth landing on now that it
   *  opens on the org's agents. Nothing here reads org settings any more, so
   *  the landing no longer waits on a query before it can decide. */
  const project = virtualmcpid ?? null;

  if (project) {
    return (
      <Navigate
        to={DESTINATION_ROUTE.agents}
        params={{ org: org.slug, panel: undefined }}
        search={{ virtualmcpid: project, connect, siteUrl, sidepanel, main }}
        replace
      />
    );
  }

  /** No project to scope to — Home, which resolves on the Super Agent (the
   *  absence of a project segment) and opens on its Overview default view. */
  return (
    <Navigate
      to={DESTINATION_ROUTE.home}
      params={{ org: org.slug }}
      search={{ connect, siteUrl, sidepanel, main, virtualmcpid }}
      replace
    />
  );
}
