/**
 * Translates a legacy `/$org/$taskId` URL into the first-class shape.
 *
 * Mounted as a SIBLING of the workspace, not in place of it, and never from
 * `beforeLoad`. Rendering `<Navigate>` alongside the shell rewrites the URL
 * without unmounting anything: the destination is another child of the same
 * pathless `agentShellLayout`, so the chat, the panels and the sandbox
 * providers stay exactly as they are. Returning `<Navigate>` INSTEAD of the
 * children would tear the workspace down and rebuild it — a visible flash on
 * every legacy link.
 *
 * Each branch below spells its `to` as a literal so TanStack infers that
 * route's own params and search — a renamed route is a compile error here
 * rather than a runtime 404.
 */

import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import {
  translateLegacyThreadRoute,
  type LegacyThreadTarget,
} from "@/lib/legacy-route-translation";

function useLegacyThreadTarget(): LegacyThreadTarget | null {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });

  const { org, taskId } = params;
  if (!org || taskId === undefined) return null;
  return translateLegacyThreadRoute({ org, taskId, search });
}

export function LegacyThreadRedirect() {
  const target = useLegacyThreadTarget();
  if (!target) return null;

  if (target.to === "/$org/agents/{-$panel}") {
    return (
      <Navigate
        to="/$org/agents/{-$panel}"
        params={{ org: target.params.org, panel: target.params.panel }}
        search={() => ({
          ...target.search,
          virtualmcpid: target.params.project,
        })}
        replace
      />
    );
  }
  if (target.to === "/$org/tasks/{-$taskKey}") {
    return (
      <Navigate
        to="/$org/tasks/{-$taskKey}"
        params={{ org: target.params.org }}
        search={target.search}
        replace
      />
    );
  }
  if (target.to === "/$org/reports") {
    return (
      <Navigate
        to="/$org/reports"
        params={{ org: target.params.org }}
        search={target.search}
        replace
      />
    );
  }
  if (target.to === "/$org/library") {
    return (
      <Navigate
        to="/$org/library"
        params={{ org: target.params.org }}
        search={target.search}
        replace
      />
    );
  }
  return (
    <Navigate
      to="/$org/home"
      params={{ org: target.params.org }}
      search={target.search}
      replace
    />
  );
}
