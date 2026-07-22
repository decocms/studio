import { Columns03 } from "@untitledui/icons";
import { HeaderTabButton } from "@/web/layouts/main-panel-tabs/header-tab-button";
import { track } from "@/web/lib/posthog-client";
import { useT } from "@/web/i18n/use-t";
import { useMainOverlayToggle } from "./use-main-overlay-toggle";

/**
 * Tasks toggle — the org task board, opened next to the chat like the Library
 * (via `?main=board`) rather than as a separate route. Sits in the LEFT toolbar
 * group after Chat and Library. Agent-independent, so it's a left-group toggle,
 * not a per-agent view tab.
 */
export function TasksToggle() {
  const t = useT();
  const { active, enabled, toggle } = useMainOverlayToggle("board");

  if (!enabled) return null;

  return (
    <HeaderTabButton
      title={t("agentShellLayout.tasksToggle.tasks")}
      icon={{ kind: "component", Component: Columns03 }}
      active={active}
      className="wco-no-drag h-10 md:h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => {
        track("agent_toolbar_toggled", {
          button: "tasks",
          next_state: active ? "closed" : "open",
        });
        toggle();
      }}
    />
  );
}
