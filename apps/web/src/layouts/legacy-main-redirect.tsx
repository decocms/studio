/**
 * Render-time compatibility for `?main=` and redundant query-carried agent
 * identity. Retired panel paths are handled before render by the router's
 * compatibility boundary. Every emitted URL is canonical.
 */

import type { ReactNode } from "react";
import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import {
  AGENT_ROUTE,
  DESTINATION_ROUTE,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import {
  type LegacyCanonicalTarget,
  type LegacyThreadSearch,
  resolveLegacyAgentId,
  retireLegacyAgentSearch,
  translateLegacyOrgDestinationAgentSearch,
  translateLegacyMainParam,
} from "@/lib/legacy-route-translation";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";

/** One exhaustive, route-typed renderer shared by both legacy adapters. Route
 * params remain checked against the canonical tree in every branch. */
export function LegacyCanonicalNavigate({
  target,
}: {
  target: LegacyCanonicalTarget;
}) {
  const { route, search } = target;

  switch (route.to) {
    case DESTINATION_ROUTE.home:
      return (
        <Navigate
          to={DESTINATION_ROUTE.home}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case DESTINATION_ROUTE.tasks:
      return (
        <Navigate
          to={DESTINATION_ROUTE.tasks}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case DESTINATION_ROUTE.reports:
      return (
        <Navigate
          to={DESTINATION_ROUTE.reports}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case DESTINATION_ROUTE.library:
      return (
        <Navigate
          to={DESTINATION_ROUTE.library}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case DESTINATION_ROUTE.discover:
      return (
        <Navigate
          to={DESTINATION_ROUTE.discover}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.root:
      return (
        <Navigate
          to={AGENT_ROUTE.root}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.siteEditor:
      return (
        <Navigate
          to={AGENT_ROUTE.siteEditor}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.siteEditorContent:
      return (
        <Navigate
          to={AGENT_ROUTE.siteEditorContent}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.siteEditorCode:
      return (
        <Navigate
          to={AGENT_ROUTE.siteEditorCode}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.settings:
      return (
        <Navigate
          to={AGENT_ROUTE.settings}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.assets:
      return (
        <Navigate
          to={AGENT_ROUTE.assets}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.git:
      return (
        <Navigate
          to={AGENT_ROUTE.git}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.hosting:
      return (
        <Navigate
          to={AGENT_ROUTE.hosting}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.e2e:
      return (
        <Navigate
          to={AGENT_ROUTE.e2e}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.analytics:
      return (
        <Navigate
          to={AGENT_ROUTE.analytics}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.monitor:
      return (
        <Navigate
          to={AGENT_ROUTE.monitor}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.automations:
      return (
        <Navigate
          to={AGENT_ROUTE.automations}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.automation:
      return (
        <Navigate
          to={AGENT_ROUTE.automation}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.app:
      return (
        <Navigate
          to={AGENT_ROUTE.app}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.view:
      return (
        <Navigate
          to={AGENT_ROUTE.view}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.outputFile:
      return (
        <Navigate
          to={AGENT_ROUTE.outputFile}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.outputDeck:
      return (
        <Navigate
          to={AGENT_ROUTE.outputDeck}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.libraryFile:
      return (
        <Navigate
          to={AGENT_ROUTE.libraryFile}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case AGENT_ROUTE.connectSources:
      return (
        <Navigate
          to={AGENT_ROUTE.connectSources}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
  }
}

export function LegacyMainRedirect({ children }: { children?: ReactNode }) {
  const params = useParams({ strict: false });
  const search: LegacyThreadSearch = useSearch({ strict: false });
  const fallbackAgentId = useRouteVirtualMcpId();
  const leafRoutePath = useLeafRoutePath();

  const org = params.org;
  /** The legacy thread route translates its own path, identity and main view. */
  if (!org || params.taskId !== undefined) return children ?? null;

  const agentId = resolveLegacyAgentId({
    agentIdParam: params.agentId,
    virtualMcpIdSearch: search.virtualmcpid,
    fallbackAgentId,
  });

  const translation =
    (search.main !== undefined
      ? translateLegacyMainParam({
          org,
          agentId,
          main: search.main,
          search,
        })
      : null) ??
    translateLegacyOrgDestinationAgentSearch({
      org,
      routePath: leafRoutePath,
      search,
    });

  if (translation?.kind === "same-route") {
    return <Navigate to="." search={translation.search} hash={true} replace />;
  }
  if (translation?.kind === "canonical") {
    return <LegacyCanonicalNavigate target={translation} />;
  }

  /** Canonical path identity wins over a redundant/stale legacy query. This
   * cleanup deliberately stays on the current child route. A recognized old
   * view segment resolves to another agent above and therefore cannot enter
   * this branch. */
  if (
    params.agentId !== undefined &&
    params.agentId === agentId &&
    search.virtualmcpid !== undefined
  ) {
    return (
      <Navigate
        to="."
        search={retireLegacyAgentSearch(search)}
        hash={true}
        replace
      />
    );
  }

  return children ?? null;
}
