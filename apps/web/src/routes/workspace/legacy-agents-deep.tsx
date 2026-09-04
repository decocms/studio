import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import { LegacyCanonicalNavigate } from "@/layouts/legacy-main-redirect";
import {
  type LegacyThreadSearch,
  resolveLegacyAgentId,
  translateLegacyPanelRoute,
} from "@/lib/legacy-route-translation";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";

/** Preserve the retired namespace long enough to distinguish an arbitrary
 * view name from a canonical project id. Rewriting `/agents` to `/projects`
 * before this decision would turn `/agents/my-view` into a fake project. */
export default function LegacyAgentsDeepRoute() {
  const params = useParams({ strict: false });
  const search: LegacyThreadSearch = useSearch({ strict: false });
  const { org } = useProjectContext();
  const splat =
    "_splat" in params && typeof params._splat === "string"
      ? params._splat
      : "";
  const firstSegment = splat.split("/").find(Boolean);

  if (!firstSegment) {
    return (
      <Navigate
        to="/$org/projects"
        params={{ org: org.slug }}
        search={search}
        hash
        replace
      />
    );
  }

  const agentId = resolveLegacyAgentId({
    virtualMcpIdSearch: search.virtualmcpid,
    fallbackAgentId: getWellKnownDecopilotVirtualMCP(org.id).id,
  });
  const translation = translateLegacyPanelRoute({
    org: org.slug,
    agentId,
    panel: firstSegment,
    source: "view-first",
    search,
  });

  return translation?.kind === "canonical" ? (
    <LegacyCanonicalNavigate
      target={{ route: translation.route, search: translation.search }}
    />
  ) : (
    <Navigate to="/$org/home" params={{ org: org.slug }} replace />
  );
}
