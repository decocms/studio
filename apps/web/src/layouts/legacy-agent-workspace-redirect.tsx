/**
 * Render-time adapter for retired `/agents/<view>` paths.
 *
 * It mounts inside the authenticated shell, where the current organization is
 * already authoritative, but outside AgentInsetProvider so a view name can
 * never be mistaken for an agent id by task/runtime providers.
 */

import type { ReactNode } from "react";
import { useParams, useRouterState, useSearch } from "@tanstack/react-router";
import { LegacyCanonicalNavigate } from "@/layouts/legacy-main-redirect";
import {
  type LegacyThreadSearch,
  translateLegacyAgentPath,
} from "@/lib/legacy-route-translation";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";

export function LegacyAgentWorkspaceRedirect({
  children,
}: {
  children: ReactNode;
}) {
  const params = useParams({ strict: false });
  const search: LegacyThreadSearch = useSearch({ strict: false });
  const pathname = useRouterState({
    select: (state) =>
      state.matches.at(-1)?.pathname ?? state.location.pathname,
  });
  const { org: organization } = useProjectContext();

  const target = params.org
    ? translateLegacyAgentPath({
        pathname,
        org: params.org,
        pathAgentId: params.agentId,
        pathLegacyView: params.legacyView,
        fallbackAgentId: getWellKnownDecopilotVirtualMCP(organization.id).id,
        search,
      })
    : null;

  return target ? <LegacyCanonicalNavigate target={target} /> : children;
}
