/**
 * Org landing (`/$org`) — a resolver, never a page.
 *
 * It picks a DESTINATION and no thread at all: cold entry must not mint a
 * conversation nobody asked for. In order: a `?main=` deep link that now has a
 * real path of its own, then the org's main agent (`useMainAgentId`), then
 * Home.
 */
import { getRouteApi, Navigate } from "@tanstack/react-router";
import { useProjectContext } from "@/sdk";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { LegacyCanonicalNavigate } from "@/layouts/legacy-main-redirect";
import { translateLegacyMainParam } from "@/lib/legacy-route-translation";

const route = getRouteApi("/shell/$org/org-shell/");

export default function OrgHome() {
  const { org } = useProjectContext();
  /** `main` carries a legacy deep link into a view (e.g. `board` = Tasks,
   *  `files` = Library) through the redirect. The destination-backed
   *  values land on their own page below; every other value rides along to the
   *  agent route, where `<LegacyMainRedirect />` retires it into its canonical
   *  child route. `task` rides along to the board only, which is the one
   *  destination that retires it into its path. */
  const search = route.useSearch();
  const { main, virtualmcpid } = search;

  // A promoted `?main=` outranks everything: the URL already says which page.
  // Use the shared translator so each destination reclaims its own payload
  // (Library `path`, Tasks filters/card, and shared layout state) before the
  // compatibility schema is left behind.
  if (main !== undefined) {
    const translation = translateLegacyMainParam({
      org: org.slug,
      agentId: virtualmcpid,
      main,
      search,
    });
    if (translation?.kind === "canonical") {
      return <LegacyCanonicalNavigate target={translation} />;
    }
  }

  /** The scope the URL NAMES, and nothing else. This resolver is where
   *  cross-org travel lands (`travelTo` in the picker navigates to `/$org`
   *  with the picked project), so it forwards that scope and otherwise falls
   *  through to the org home — which is the page worth landing on now that it
   *  opens on the org's agents. Nothing here reads org settings any more, so
   *  the landing no longer waits on a query before it can decide. */
  const project = virtualmcpid?.trim() || null;

  if (project) {
    return (
      <Navigate
        to={DESTINATION_ROUTE.projects}
        params={{ org: org.slug, agentId: project }}
        search={{ ...search, virtualmcpid: undefined }}
        hash={true}
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
      search={{ ...search, virtualmcpid: undefined }}
      hash={true}
      replace
    />
  );
}
