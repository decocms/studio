import { useCompactPageLayout } from "@/hooks/use-preferences";
import { HeaderTabButton } from "./header-tab-button";
import type { TabIcon } from "./resolve-tab-icon";
import type { Tab } from "./use-main-panel-tabs";
import { resolveAutomationsPillClickTarget } from "./tab-id";
import { Page } from "@/components/page";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { track } from "@/lib/posthog-client";
import { isAutomationsPillActive } from "./tab-id";
import { usePanelNavigate } from "./use-panel-navigate";
import { useMainPanelTabs } from "./use-main-panel-tabs";
import { TabIconGlyph } from "./tab-icon-glyph";

/** Route views share the page tab style. Selecting the current view keeps it open. */
function CompactMainPanelTabsBar({
  virtualMcpId,
  taskId,
}: {
  virtualMcpId: string;
  taskId: string | null;
}) {
  const { openPanel } = usePanelNavigate();
  const { tabs, activeTab, mainOpen } = useMainPanelTabs({
    virtualMcpId,
    taskId,
  });
  if (tabs.length === 0) return null;
  return (
    <Page.Tabs data-tour={LAYOUT_TOUR_ANCHORS.surfaceTabs}>
      {tabs.map((tab) => {
        const active =
          tab.id === "automations"
            ? isAutomationsPillActive({ activeTab, mainOpen })
            : mainOpen && tab.id === activeTab;
        return (
          <Page.Tab
            key={tab.id}
            active={active}
            onClick={() => {
              if (active) return;
              track("main_panel_tab_clicked", {
                virtual_mcp_id: virtualMcpId,
                tab_id: tab.id,
                tab_kind: tab.kind,
                was_active: false,
              });
              openPanel(tab.id);
            }}
          >
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center"
            >
              <TabIconGlyph icon={tab.icon} />
            </span>
            {tab.title}
          </Page.Tab>
        );
      })}
    </Page.Tabs>
  );
}

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

function ClassicMainPanelTabsBar({
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
      className="flex items-center min-w-0 gap-0.5 overflow-x-auto no-scrollbar"
      data-tour={LAYOUT_TOUR_ANCHORS.surfaceTabs}
    >
      {items.map((item) => (
        <HeaderTabButton
          key={item.id}
          title={item.title}
          icon={item.icon}
          showIcon={item.id !== "site-editor" && item.id !== "content"}
          active={item.active}
          locked={item.locked}
          onClick={item.onSelect}
          labelCollapse={item.labelCollapse}
        />
      ))}
    </div>
  );
}

export function MainPanelTabsBar(props: {
  virtualMcpId: string;
  taskId: string | null;
}) {
  const compact = useCompactPageLayout();
  return compact ? (
    <CompactMainPanelTabsBar {...props} />
  ) : (
    <ClassicMainPanelTabsBar {...props} />
  );
}
