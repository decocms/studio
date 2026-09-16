import { Page } from "@/components/page";
import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { track } from "@/lib/posthog-client";
import { isAutomationsPillActive } from "./tab-id";
import { usePanelNavigate } from "./use-panel-navigate";
import { useMainPanelTabs } from "./use-main-panel-tabs";
import { TabIconGlyph } from "./tab-icon-glyph";

/** Route views share the page tab style. Selecting the current view keeps it open. */
export function MainPanelTabsBar({
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
            {tab.kind !== "system" && (
              <span className="flex size-4 items-center justify-center">
                <TabIconGlyph icon={tab.icon} />
              </span>
            )}
            {tab.title}
          </Page.Tab>
        );
      })}
    </Page.Tabs>
  );
}
