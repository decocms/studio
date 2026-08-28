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
import { selectBarSlots, MAX_VISIBLE } from "./select-bar-slots";
import { HeaderTabButton } from "./header-tab-button";
import { TabOverflowMenu } from "./tab-overflow-menu";
import type { TabIcon } from "./resolve-tab-icon";
import { track } from "@/lib/posthog-client";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useReportsOnly } from "@/hooks/use-organization-settings";

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
  maxVisible = MAX_VISIBLE,
}: {
  virtualMcpId: string;
  taskId: string | null;
  disableActiveMainToggle?: boolean;
  /** Space-adaptive cap from the shell; clamped to `MAX_VISIBLE`. */
  maxVisible?: number;
}) {
  const { openPanel, closePanel } = usePanelNavigate();
  const { tabs, activeTab, mainOpen, setActiveTab, leadTabId } =
    useMainPanelTabs({
      virtualMcpId,
      taskId,
    });
  const reportsOnly = useReportsOnly();
  // Key is versioned (v2): the default lead order changed (Preview · Content ·
  // Library now lead), so arrangements persisted under the old order — which
  // could pin Code second — must be discarded rather than override the new
  // default.
  const [persistedVisible, setPersistedVisible] = useLocalStorage<string[]>(
    `main-tab-bar:v2:${virtualMcpId}`,
    [],
  );

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

  // Code agents (a clonable-source repo, surfaced by a "code" view tab) keep a
  // minimal bar: Preview stays pinned and the active view shows beside it;
  // everything else collapses into the stack popover. Reports-only orgs also
  // expose a "code" tab but get their own curated bar, so they're excluded.
  const isCodeAgent = !reportsOnly && items.some((i) => i.id === "code");

  // Pure slotting (visible bar vs overflow popover) — see select-bar-slots.ts.
  const { visible, overflow } = selectBarSlots({
    items,
    persisted: persistedVisible,
    maxVisible,
    isCodeAgent,
    leadId: leadTabId,
  });

  // Lookup for click handlers + the responsive cap for overflow-promotion.
  const byId = new Map(items.map((i) => [i.id, i]));
  const effectiveMax = Math.max(1, Math.min(maxVisible, MAX_VISIBLE));

  // Opening an overflow item swaps it into the last visible slot and persists
  // the new arrangement so it sticks. Code agents keep their pinned Preview +
  // active-view layout, so the click just activates the view (no promotion).
  const openFromOverflow = (id: string) => {
    if (!isCodeAgent) {
      const kept = visible.slice(0, effectiveMax - 1).map((i) => i.id);
      setPersistedVisible([...kept, id]);
    }
    byId.get(id)?.onSelect();
  };

  return (
    <div className="flex items-center min-w-0 gap-0.5">
      {visible.map((item) => (
        <HeaderTabButton
          key={item.id}
          title={item.title}
          icon={item.icon}
          active={item.active}
          locked={item.locked}
          onClick={item.onSelect}
          dataTour={`tour-tab-${item.id}`}
          labelCollapse={item.labelCollapse}
        />
      ))}
      {overflow.length > 0 && (
        <TabOverflowMenu
          overflow={overflow.map((i) => ({
            id: i.id,
            title: i.title,
            icon: i.icon,
            active: i.active,
          }))}
          onSelect={openFromOverflow}
        />
      )}
    </div>
  );
}
