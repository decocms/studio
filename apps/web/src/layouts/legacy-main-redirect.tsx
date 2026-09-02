/**
 * Retires a legacy `?main=` — the one place it is read, for every route under
 * the agent shell.
 *
 * `?main=` was both the view and its visibility. The view is the chat route's
 * `{-$panel}` segment now and the visibility is `?mainpanel`, but the old param
 * is in bookmarks and in mail that is already delivered — the Commerce
 * Discovery completion mail and the share-invite `redirectTo` both mint
 * `?main=app:<connectionId>:<toolName>` (`apps/api/src/tools/reports/setup.ts`,
 * `apps/api/src/api/routes/commerce-diagnostic-share.ts`) — so it is accepted
 * as an INPUT forever and rewritten on entry.
 *
 * Mounted as a SIBLING of the workspace, like `<LegacyThreadRedirect />`: the
 * destination is another child of the same pathless `agentShellLayout`, so the
 * rewrite never tears the chat and its providers down. The legacy
 * `/$org/$taskId` is excluded because that route's own translator already emits
 * the new shape — two `<Navigate>`s for one URL would fight.
 */

import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import {
  type LegacyMainTranslation,
  translateLegacyMainParam,
} from "@/lib/legacy-route-translation";

export function LegacyMainRedirect() {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false }) as {
    main?: string | 0;
    virtualmcpid?: string;
  };

  const org = params.org;
  /** The legacy thread route translates its own `main`, path param and all. */
  if (!org || params.taskId !== undefined) return null;

  const view: LegacyMainTranslation | null = translateLegacyMainParam(
    search.main,
    params.panel,
  );
  if (!view) return null;

  if (view.to === null) {
    return (
      <Navigate
        to="."
        search={(prev) => ({ ...prev, ...view.search })}
        replace
      />
    );
  }

  if (view.to === "/$org/agents/{-$panel}") {
    return (
      <Navigate
        to="/$org/agents/{-$panel}"
        params={{ org, panel: view.panel }}
        search={(prev) => ({ ...prev, ...view.search })}
        replace
      />
    );
  }

  if (view.to === "/$org/tasks/{-$taskKey}") {
    return (
      <Navigate
        to="/$org/tasks/{-$taskKey}"
        params={{ org, taskKey: params.taskKey }}
        search={(prev) => ({ ...prev, ...view.search })}
        replace
      />
    );
  }

  return (
    <Navigate
      to={view.to}
      params={{ org }}
      search={(prev) => ({ ...prev, ...view.search })}
      replace
    />
  );
}
