/**
 * Render-time compatibility for `?main=` and redundant query-carried agent
 * identity. Retired panel paths are handled before render by the router's
 * compatibility boundary. Every emitted URL is canonical.
 */

import type { ReactNode } from "react";
import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import {
  PROJECT_ROUTE,
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
    case PROJECT_ROUTE.root:
      return (
        <Navigate
          to={PROJECT_ROUTE.root}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.tasks:
      return (
        <Navigate
          to={PROJECT_ROUTE.tasks}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.reports:
      return (
        <Navigate
          to={PROJECT_ROUTE.reports}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.siteEditor:
      return (
        <Navigate
          to={PROJECT_ROUTE.siteEditor}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.siteEditorContent:
      return (
        <Navigate
          to={PROJECT_ROUTE.siteEditorContent}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.siteEditorCode:
      return (
        <Navigate
          to={PROJECT_ROUTE.siteEditorCode}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.settings:
      return (
        <Navigate
          to={PROJECT_ROUTE.settings}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.assets:
      return (
        <Navigate
          to={PROJECT_ROUTE.assets}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.git:
      return (
        <Navigate
          to={PROJECT_ROUTE.git}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.hosting:
      return (
        <Navigate
          to={PROJECT_ROUTE.hosting}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.e2e:
      return (
        <Navigate
          to={PROJECT_ROUTE.e2e}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.analytics:
      return (
        <Navigate
          to={PROJECT_ROUTE.analytics}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.monitor:
      return (
        <Navigate
          to={PROJECT_ROUTE.monitor}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.automations:
      return (
        <Navigate
          to={PROJECT_ROUTE.automations}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.automation:
      return (
        <Navigate
          to={PROJECT_ROUTE.automation}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.app:
      return (
        <Navigate
          to={PROJECT_ROUTE.app}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.view:
      return (
        <Navigate
          to={PROJECT_ROUTE.view}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.outputFile:
      return (
        <Navigate
          to={PROJECT_ROUTE.outputFile}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.outputDeck:
      return (
        <Navigate
          to={PROJECT_ROUTE.outputDeck}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.libraryFile:
      return (
        <Navigate
          to={PROJECT_ROUTE.libraryFile}
          params={route.params}
          search={search}
          hash={true}
          replace
        />
      );
    case PROJECT_ROUTE.connectSources:
      return (
        <Navigate
          to={PROJECT_ROUTE.connectSources}
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
  /** Legacy thread and `/agents/*` alias routes translate their own path,
   * identity, and main view before canonical providers mount. */
  if (!org || params.taskId !== undefined || params._splat !== undefined) {
    return children ?? null;
  }

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
