import { Folder } from "@untitledui/icons";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { HeaderTabButton } from "@/web/layouts/main-panel-tabs/header-tab-button";
import { track } from "@/web/lib/posthog-client";

/**
 * Library toggle — sits in the LEFT toolbar group beside the Chat toggle.
 *
 * The Library (org files/assets) is agent-independent — it's the same view for
 * every agent — so it doesn't belong in the per-agent view tab bar on the
 * right. Pinning it next to Chat keeps a stable, always-present entry point
 * that never shuffles as agent-specific tabs (Overview / Preview / …) come and
 * go. Opens `?main=files`; clicking while open closes it (main=0).
 */
export function LibraryToggle() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const search = useSearch({ strict: false }) as { main?: string };
  const active = search.main === "files";

  // Needs a task route to toggle the main panel against; render nothing on
  // routes without one.
  if (!params.org || !params.taskId) return null;
  const { org, taskId } = params;

  return (
    <HeaderTabButton
      title="Library"
      icon={{ kind: "component", Component: Folder }}
      active={active}
      className="wco-no-drag h-10 md:h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => {
        track("agent_toolbar_toggled", {
          button: "library",
          next_state: active ? "closed" : "open",
        });
        navigate({
          to: "/$org/$taskId",
          params: { org, taskId },
          search: (prev: Record<string, unknown>) => ({
            ...prev,
            main: active ? "0" : "files",
          }),
          replace: true,
        });
      }}
    />
  );
}
