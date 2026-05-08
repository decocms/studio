/**
 * MainPanelTabsBar — horizontal tab strip rendered in the agent-shell
 * header via `Toolbar.Tabs` (portal).
 *
 * Rendering pipeline:
 *   1. Normalize tabs via useMainPanelTabs (system / agent / expanded).
 *   2. Compute the per-tab active flag; the Automations system tab uses
 *      isAutomationsPillActive so it lights up on list + detail URLs.
 *   3. Promote the active tab into the visible slice when needed via
 *      selectTabSlots (cap = 6).
 *   4. Render each visible tab as <HeaderTabButton>. If there is
 *      overflow, append a <TabOverflowMenu>.
 *
 * Click routing: the Automations pill uses resolveAutomationsPillClickTarget
 * (list/detail collapse); every other tab uses the hook's setActiveTab,
 * which already routes through resolveTabClickTarget (click active → close).
 */

import { useNavigate } from "@tanstack/react-router";
import {
  isAutomationsPillActive,
  resolveAutomationsPillClickTarget,
} from "./tab-id";
import { useMainPanelTabs, type Tab } from "./use-main-panel-tabs";
import { selectTabSlots } from "./select-tab-slots";
import { HeaderTabButton } from "./header-tab-button";
import { TabOverflowMenu } from "./tab-overflow-menu";
import { track } from "@/web/lib/posthog-client";

const MAX_VISIBLE_TABS = 6;

export function MainPanelTabsBar({
  virtualMcpId,
  taskId,
}: {
  virtualMcpId: string;
  taskId: string;
}) {
  const navigate = useNavigate();
  const { tabs, activeTab, mainOpen, setActiveTab } = useMainPanelTabs({
    virtualMcpId,
    taskId,
  });

  const automationsActive = isAutomationsPillActive({ activeTab, mainOpen });

  const isTabActive = (tab: Tab) => {
    if (tab.id === "automations") return automationsActive;
    return mainOpen && tab.id === activeTab;
  };

  const activeFromTabs = tabs.find((t) => isTabActive(t));
  const effectiveActiveId = activeFromTabs?.id ?? null;

  const { visible, overflow } = selectTabSlots(
    tabs,
    effectiveActiveId,
    MAX_VISIBLE_TABS,
  );

  const handleSelect = (id: string) => {
    const clicked = tabs.find((t) => t.id === id);
    const wasActive = effectiveActiveId === id && mainOpen;
    track("main_panel_tab_clicked", {
      virtual_mcp_id: virtualMcpId,
      tab_id: id,
      tab_kind: clicked?.kind ?? null,
      was_active: wasActive,
    });
    if (id === "automations") {
      const target = resolveAutomationsPillClickTarget({
        activeTab,
        mainOpen,
      });
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, main: target }),
        replace: true,
      });
      return;
    }
    setActiveTab(id);
  };

  return (
    <div className="flex items-center min-w-0 ml-auto gap-0.5">
      {visible.map((tab) => (
        <HeaderTabButton
          key={tab.id}
          title={tab.title}
          icon={tab.icon}
          active={isTabActive(tab)}
          onClick={() => handleSelect(tab.id)}
        />
      ))}
      {overflow.length > 0 && (
        <TabOverflowMenu overflow={overflow} onSelect={handleSelect} />
      )}
    </div>
  );
}
