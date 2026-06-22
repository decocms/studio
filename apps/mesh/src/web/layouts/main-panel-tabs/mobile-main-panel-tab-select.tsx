import { useNavigate } from "@tanstack/react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@deco/ui/components/select.tsx";
import {
  isAutomationsPillActive,
  resolveAutomationsPillClickTarget,
} from "./tab-id";
import { useMainPanelTabs, type Tab } from "./use-main-panel-tabs";
import { track } from "@/web/lib/posthog-client";

const MOBILE_SELECT_SENTINEL = "__mobile-main-panel-tab-select__";

export function resolveMobileMainPanelTabSelectLabel({
  tabs,
  activeTab,
  mainOpen,
}: {
  tabs: Array<{ id: string; title: string }>;
  activeTab: string;
  mainOpen: boolean;
}): string {
  const active = tabs.find((tab) => tab.id === activeTab);
  if (mainOpen) return active?.title ?? "Main view";
  return active?.title ?? tabs[0]?.title ?? "Main view";
}

export function MobileMainPanelTabSelect({
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
  const label = resolveMobileMainPanelTabSelectLabel({
    tabs,
    activeTab,
    mainOpen,
  });
  const automationsActive = isAutomationsPillActive({ activeTab, mainOpen });

  const handleSelect = (id: string) => {
    if (id === MOBILE_SELECT_SENTINEL) return;
    const clicked = tabs.find((tab) => tab.id === id);
    track("main_panel_tab_clicked", {
      virtual_mcp_id: virtualMcpId,
      tab_id: id,
      tab_kind: clicked?.kind ?? null,
      was_active:
        id === "automations" ? automationsActive : mainOpen && activeTab === id,
      source: "mobile_select",
    });
    if (id === "automations") {
      const target = resolveAutomationsPillClickTarget({ activeTab, mainOpen });
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
    <Select value={MOBILE_SELECT_SENTINEL} onValueChange={handleSelect}>
      <SelectTrigger
        aria-label="Main panel tab"
        className="h-10 w-full min-w-0 max-w-[9rem] rounded-md bg-transparent px-2 text-xs shadow-none card-shadow-none"
      >
        <span className="min-w-0 truncate">{label}</span>
      </SelectTrigger>
      <SelectContent align="end" className="w-56">
        <SelectItem
          value={MOBILE_SELECT_SENTINEL}
          disabled
          hideCheck
          className="hidden"
        >
          {label}
        </SelectItem>
        {tabs.map((tab: Tab) => (
          <SelectItem key={tab.id} value={tab.id}>
            {tab.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
