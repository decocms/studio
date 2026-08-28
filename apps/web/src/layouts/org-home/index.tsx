/**
 * Org landing (`/$org`) — a resolver, never a page.
 *
 * It picks a DESTINATION and no thread at all: cold entry must not mint a
 * conversation nobody asked for. In order: a `?main=` deep link that now has a
 * real path of its own, then the org's main agent (`useMainAgentId`), then
 * Home.
 */
import { Navigate, useSearch } from "@tanstack/react-router";
import { useProjectContext, useVirtualMCPs } from "@/sdk";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { useMainAgentId } from "@/hooks/use-organization-settings";
import { ShellRouteLoading } from "@/layouts/shell-route-loading";

/**
 * `?main=` values that became destinations of their own. A deep link minted
 * before the promotion (a shared `/$org?main=board&task=…`, the short card
 * link) keeps working by landing on the path instead of the overlay — the same
 * table `translateLegacyThreadRoute` applies to `/$org/$taskId`.
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
  const { mainAgentId, isPending: settingsPending } = useMainAgentId();
  /** Suspense read (cache-warm from the shell), used to validate the main agent
   *  still exists so a deleted one falls back to the Super Agent. */
  const agents = useVirtualMCPs();
  /** `main` carries a deep link into a main-panel overlay (e.g. `board` =
   *  Tasks, `files` = Library) through the redirect. */
  const { connect, siteUrl, main, task, sidepanel } = useSearch({
    strict: false,
  }) as {
    connect?: string;
    siteUrl?: string;
    main?: string;
    task?: string;
    sidepanel?: boolean;
  };

  /** Wait for the org settings before deciding, so the landing never flashes
   *  Home on its way to the main agent. Everything above is a hook, so this
   *  early return is Rules-of-Hooks clean. */
  if (settingsPending) return <ShellRouteLoading />;

  // A promoted `?main=` outranks everything: the URL already says which page.
  if (isPromotedMainTab(main)) {
    return (
      <Navigate
        to={DESTINATION_BY_MAIN_TAB[main]}
        params={{ org: org.slug, project: undefined }}
        search={{ connect, siteUrl, task, sidepanel }}
        replace
      />
    );
  }

  /** The Super Agent is synthesized (not in the list), so only real main-agent
   *  ids are validated against it. */
  const mainAgentValid =
    mainAgentId != null && (agents ?? []).some((a) => a.id === mainAgentId);

  /** The main agent IS a project under the new grammar, so its id moves from
   *  `?virtualmcpid=` into the path. It creates no thread — with no `?thread=`
   *  the chat panel opens an empty composer. */
  const project = mainAgentValid ? mainAgentId : null;

  if (project) {
    return (
      <Navigate
        to={DESTINATION_ROUTE.chat}
        params={{ org: org.slug, project }}
        search={{ connect, siteUrl, task, sidepanel }}
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
      search={{ connect, siteUrl, sidepanel }}
      replace
    />
  );
}
