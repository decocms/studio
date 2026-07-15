import { useMainPanelTabs, type Tab } from "./use-main-panel-tabs";
import { selectTabSlots } from "./select-tab-slots";
import { HeaderTabButton } from "./header-tab-button";
import { TabOverflowMenu } from "./tab-overflow-menu";
import { track } from "@/web/lib/posthog-client";
import { useNeedsRuntimeSetup } from "@/web/components/chat/use-needs-runtime-setup";

const MAX_VISIBLE_TABS = 6;

export function MainPanelTabsBar({
  virtualMcpId,
  taskId,
  disableActiveMainToggle = false,
}: {
  virtualMcpId: string;
  taskId: string;
  disableActiveMainToggle?: boolean;
}) {
  const { tabs, activeTab, mainOpen, setActiveTab } = useMainPanelTabs({
    virtualMcpId,
    taskId,
  });

  // While the org has no usable runtime, you can't open any view — the app is
  // gated behind connecting a provider (or picking a local coding agent) in the
  // chat panel. Disable the whole tab strip so it isn't a dead-end open.
  const needsSetup = useNeedsRuntimeSetup();

  const isTabActive = (tab: Tab) => mainOpen && tab.id === activeTab;

  const activeFromTabs = tabs.find((t) => isTabActive(t));
  const effectiveActiveId = activeFromTabs?.id ?? null;

  const { visible, overflow } = selectTabSlots(
    tabs,
    effectiveActiveId,
    MAX_VISIBLE_TABS,
  );

  const handleSelect = (id: string) => {
    const clicked = tabs.find((t) => t.id === id);
    if (disableActiveMainToggle && clicked && isTabActive(clicked)) return;
    const wasActive = effectiveActiveId === id && mainOpen;
    track("main_panel_tab_clicked", {
      virtual_mcp_id: virtualMcpId,
      tab_id: id,
      tab_kind: clicked?.kind ?? null,
      was_active: wasActive,
    });
    setActiveTab(id);
  };

  return (
    <div className="flex items-center min-w-0 gap-0.5">
      {visible.map((tab) => (
        <HeaderTabButton
          key={tab.id}
          title={tab.title}
          icon={tab.icon}
          active={isTabActive(tab)}
          disabled={needsSetup || (disableActiveMainToggle && isTabActive(tab))}
          onClick={() => handleSelect(tab.id)}
        />
      ))}
      {overflow.length > 0 && !needsSetup && (
        <TabOverflowMenu overflow={overflow} onSelect={handleSelect} />
      )}
    </div>
  );
}
