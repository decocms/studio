/**
 * Forever-supported adapter for `/$org/$taskId`.
 *
 * The pure translator emits one canonical route directly. The shell renders
 * this adapter instead of the workspace while the URL settles, so task and
 * runtime providers cannot act on provisional legacy identity. `hash: true`
 * preserves old anchored/shared links.
 */

import { useParams, useSearch } from "@tanstack/react-router";
import { LegacyCanonicalNavigate } from "@/layouts/legacy-main-redirect";
import {
  type LegacyCanonicalTarget,
  translateLegacyThreadRoute,
} from "@/lib/legacy-route-translation";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";

function useLegacyThreadTarget(): LegacyCanonicalTarget | null {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const { org: organization } = useProjectContext();

  const { org, taskId } = params;
  if (!org || taskId === undefined) return null;
  return translateLegacyThreadRoute({
    org,
    taskId,
    fallbackAgentId: getWellKnownDecopilotVirtualMCP(organization.id).id,
    search,
  });
}

export function LegacyThreadRedirect() {
  const target = useLegacyThreadTarget();
  return target ? <LegacyCanonicalNavigate target={target} /> : null;
}
