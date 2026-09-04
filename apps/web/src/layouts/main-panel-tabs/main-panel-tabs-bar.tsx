/**
 * MainPanelTabsBar — the main panel's button row for controls local to the
 * current surface plus contextual and per-thread views. Durable project views
 * live in the sidebar.
 *
 * Click routing: the Automations pill uses resolveAutomationsPillClickTarget
 * (list/detail collapse); every other tab uses the hook's setActiveTab
 * (tab-as-toggle via resolveTabClickTarget).
 */

import {
  isAutomationsPillActive,
  resolveAutomationsPillClickTarget,
} from "./tab-id";
import { usePanelNavigate } from "./use-panel-navigate";
import { useMainPanelTabs } from "./main-panel-tabs-context";
import type { Tab } from "./use-main-panel-tabs";
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
  disableActiveMainToggle = false,
  omitActiveTab = false,
}: {
  disableActiveMainToggle?: boolean;
  /** Route-owned titles already identify the active view; omit its duplicate pill. */
  omitActiveTab?: boolean;
}) {
  const { openPanel, closePanel } = usePanelNavigate();
  const { virtualMcpId, tabs, activeTab, mainOpen, setActiveTab } =
    useMainPanelTabs();

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
  const items: BarItem[] = tabs
    .filter((tab) => !omitActiveTab || !isTabActive(tab))
    .map((tab) => ({
      id: tab.id,
      title: tab.title,
      icon: tab.icon,
      active: isTabActive(tab),
      locked: disableActiveMainToggle && isTabActive(tab),
      onSelect: () => selectTab(tab.id),
      labelCollapse: tab.kind === "system" ? "sooner" : "later",
    }));

  /**
   * Every tab shows. Native and pinned-app project navigation moved to the
   * sidebar, leaving surface controls, Review changes, agent-declared tabs,
   * and ephemeral per-thread views here. The old slotting and "More tabs"
   * popover no longer need to ration the row.
   *
   * The row still scrolls horizontally: a thread can open more file / deck /
   * app pills than a narrow panel fits, and the header clips its left group so
   * the publish actions keep their place. Scrolling (and focusing a button,
   * which scrolls it into view) is what keeps those last tabs reachable.
   */
  return (
    <div
      data-route-focus-source="route"
      data-responsive-focus-group="main-route-navigation"
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
