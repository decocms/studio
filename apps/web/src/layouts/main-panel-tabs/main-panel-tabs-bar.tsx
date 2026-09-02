/**
 * MainPanelTabsBar — the main panel's button row: the agent-independent
 * overlays (Library, Tasks) followed by the view tabs (Preview, Code, …).
 *
 * At most MAX_VISIBLE buttons show; the rest collapse into a stack popover.
 * Opening an item from the popover swaps it into the last visible slot and
 * persists that arrangement per agent (localStorage), so a button you promote
 * stays promoted across navigation — it doesn't fall back into the stack the
 * moment you switch away.
 *
 * Click routing: the Automations pill uses resolveAutomationsPillClickTarget
 * (list/detail collapse); overlays use their toggle; every other tab uses the
 * hook's setActiveTab (tab-as-toggle via resolveTabClickTarget).
 */

import {
  isAutomationsPillActive,
  resolveAutomationsPillClickTarget,
} from "./tab-id";
import { usePanelNavigate } from "./use-panel-navigate";
import { useMainPanelTabs, type Tab } from "./use-main-panel-tabs";
import { HeaderTabButton } from "./header-tab-button";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import type { TabIcon } from "./resolve-tab-icon";
import { track } from "@/lib/posthog-client";

type BarItem = {
  id: string;
  title: string;
  icon: TabIcon;
  active: boolean;
  locked: boolean;
  onSelect: () => void;
  /** How soon this button drops its label as the panel header narrows (see
   *  HeaderTabButton). Buttons with a fixed, distinctive icon go `sooner`;
   *  those that can fall back to a generic glyph hold their text `later`. */
  labelCollapse: "sooner" | "later";
};

export function MainPanelTabsBar({
  virtualMcpId,
  taskId,
  disableActiveMainToggle = false,
}: {
  virtualMcpId: string;
  taskId: string | null;
  disableActiveMainToggle?: boolean;
}) {
  const { openPanel, closePanel } = usePanelNavigate();
  const { tabs, activeTab, mainOpen, setActiveTab } = useMainPanelTabs({
    virtualMcpId,
    taskId,
  });

  const automationsActive = isAutomationsPillActive({ activeTab, mainOpen });
  const isTabActive = (tab: Tab) =>
    tab.id === "automations"
      ? automationsActive
      : mainOpen && tab.id === activeTab;

  const selectTab = (id: string) => {
    const clicked = tabs.find((t) => t.id === id);
    if (disableActiveMainToggle && clicked && isTabActive(clicked)) return;
    const wasActive = mainOpen && activeTab === id;
    track("main_panel_tab_clicked", {
      virtual_mcp_id: virtualMcpId,
      tab_id: id,
      tab_kind: clicked?.kind ?? null,
      was_active: wasActive,
    });
    if (id === "automations") {
      const target = resolveAutomationsPillClickTarget({ activeTab, mainOpen });
      if ("close" in target) closePanel();
      else openPanel(target.tabId);
      return;
    }
    setActiveTab(id);
  };

  // Library / Tasks are sidebar destinations, so only the view tabs show here.
  const items: BarItem[] = tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    icon: tab.icon,
    active: isTabActive(tab),
    locked: disableActiveMainToggle && isTabActive(tab),
    onSelect: () => selectTab(tab.id),
    labelCollapse: tab.kind === "system" ? "sooner" : "later",
  }));

  /**
   * Every tab shows. The bar now carries only the ephemeral, per-thread ones —
   * the durable project views live in the sidebar — so there is nothing to
   * collapse: the slotting, the persisted arrangement and the "More tabs"
   * popover all existed to ration a bar that no longer competes for room.
   *
   * The row still scrolls horizontally: a thread can open more file / deck /
   * app pills than a narrow panel fits, and the header clips its left group so
   * the publish actions keep their place. Scrolling (and focusing a button,
   * which scrolls it into view) is what keeps those last tabs reachable.
   */
  return (
    <div
      className="flex items-center min-w-0 gap-0.5 overflow-x-auto no-scrollbar"
      data-tour={LAYOUT_TOUR_ANCHORS.surfaceTabs}
    >
      {items.map((item) => (
        <HeaderTabButton
          key={item.id}
          title={item.title}
          icon={item.icon}
          active={item.active}
          locked={item.locked}
          onClick={item.onSelect}
          labelCollapse={item.labelCollapse}
        />
      ))}
    </div>
  );
}
