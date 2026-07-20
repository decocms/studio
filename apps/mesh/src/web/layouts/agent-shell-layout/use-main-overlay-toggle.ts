import { useRef } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";

/**
 * A left-toolbar overlay toggle (Library, Tasks) — swaps the main panel's
 * active tab for an agent-independent view (`?main=<overlayTabId>`).
 *
 * Toggling OFF restores whatever tab was showing when the overlay opened
 * instead of blanking the panel — closing the Library over a "chat + Overview"
 * layout must return to the Overview, not leave a full-width chat. When there's
 * no remembered tab (e.g. the user deep-linked straight into the overlay), it
 * falls back to the agent's default view by dropping the `main` param.
 *
 * The remembered tab lives in a ref, which survives `?main` changes because the
 * toolbar stays mounted for the life of the task route.
 */
export function useMainOverlayToggle(overlayTabId: string): {
  active: boolean;
  enabled: boolean;
  toggle: () => void;
} {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const search = useSearch({ strict: false }) as { main?: string | 0 };
  const active = search.main === overlayTabId;
  const prevTab = useRef<string | undefined>(undefined);

  const enabled = !!(params.org && params.taskId);

  const toggle = () => {
    if (!params.org || !params.taskId) return;
    const org = params.org;
    const taskId = params.taskId;
    navigate({
      to: "/$org/$taskId",
      params: { org, taskId },
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev };
        if (active) {
          // Restore the tab we replaced. A missing value means "the agent's
          // default view", represented by dropping `main` entirely.
          const restore = prevTab.current;
          if (restore && restore !== overlayTabId) next.main = restore;
          else delete next.main;
        } else {
          prevTab.current = search.main === 0 ? undefined : search.main;
          next.main = overlayTabId;
        }
        return next;
      },
      replace: true,
    });
  };

  return { active, enabled, toggle };
}
