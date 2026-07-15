import { createContext, use, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { Folder } from "@untitledui/icons";
import { Columns03, MessageCircle01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import {
  FloatingRail,
  FloatingRailDivider,
  FloatingRailIconButton,
} from "@/web/components/floating-rail";
import { HeaderActions } from "@/web/components/thread/github/header-actions";
import { useTaskBoardEnabled } from "@/web/hooks/use-organization-settings";
import type { SidePanelKind } from "@/web/hooks/use-layout-state";
import { agentShowsGithubHeaderActions } from "@/web/lib/agent-capabilities";
import { track } from "@/web/lib/posthog-client";
import { TabIconGlyph } from "@/web/layouts/main-panel-tabs/tab-icon-glyph";
import {
  isAutomationsPillActive,
  resolveAutomationsPillClickTarget,
} from "@/web/layouts/main-panel-tabs/tab-id";
import {
  useMainPanelTabs,
  type Tab,
} from "@/web/layouts/main-panel-tabs/use-main-panel-tabs";
import { useMainOverlayToggle } from "./use-main-overlay-toggle";

type RailPortalContextValue = {
  previewControlsEl: HTMLDivElement | null;
  setPreviewControlsEl: (element: HTMLDivElement | null) => void;
};

const RailPortalContext = createContext<RailPortalContextValue | null>(null);

export function DesktopAgentRailProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [previewControlsEl, setPreviewControlsEl] =
    useState<HTMLDivElement | null>(null);

  return (
    <RailPortalContext value={{ previewControlsEl, setPreviewControlsEl }}>
      {children}
    </RailPortalContext>
  );
}

export function PreviewRailPortal({ children }: { children: ReactNode }) {
  const context = use(RailPortalContext);
  if (!context?.previewControlsEl) return null;
  return createPortal(children, context.previewControlsEl);
}

function RailTabButton({
  tab,
  active,
  locked,
  onClick,
}: {
  tab: Tab;
  active: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <FloatingRailIconButton
      label={tab.title}
      active={active}
      locked={locked}
      onClick={onClick}
    >
      <TabIconGlyph icon={tab.icon} />
    </FloatingRailIconButton>
  );
}

export function DesktopAgentRail({
  entity,
  virtualMcpId,
  taskId,
  sidePanel,
  mainOpen,
  toggleSidePanel,
}: {
  entity: VirtualMCPEntity;
  virtualMcpId: string;
  taskId: string;
  sidePanel: SidePanelKind | null;
  mainOpen: boolean;
  toggleSidePanel: (sidePanel: SidePanelKind) => void;
}) {
  const navigate = useNavigate();
  const taskBoardEnabled = useTaskBoardEnabled();
  const library = useMainOverlayToggle("files");
  const tasks = useMainOverlayToggle("board");
  const railPortal = use(RailPortalContext);
  const {
    tabs,
    activeTab,
    mainOpen: resolvedMainOpen,
    setActiveTab,
  } = useMainPanelTabs({ virtualMcpId, taskId });

  const automationsActive = isAutomationsPillActive({
    activeTab,
    mainOpen: resolvedMainOpen,
  });
  const isTabActive = (tab: Tab) =>
    tab.id === "automations"
      ? automationsActive
      : resolvedMainOpen && tab.id === activeTab;

  const handleSelect = (tab: Tab) => {
    if (sidePanel === null && isTabActive(tab)) return;
    track("main_panel_tab_clicked", {
      virtual_mcp_id: virtualMcpId,
      tab_id: tab.id,
      tab_kind: tab.kind,
      was_active: isTabActive(tab),
      surface: "floating_rail",
    });
    if (tab.id === "automations") {
      const target = resolveAutomationsPillClickTarget({
        activeTab,
        mainOpen: resolvedMainOpen,
      });
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          main: target,
        }),
        replace: true,
      });
      return;
    }
    setActiveTab(tab.id);
  };

  const reviewChangesTab = tabs.find((tab) => tab.id === "git") ?? null;
  const agentTabs = tabs.filter((tab) => tab.id !== "git");
  const showGitActions = agentShowsGithubHeaderActions(entity);
  const showGitGroup = showGitActions || reviewChangesTab !== null;

  return (
    <div
      data-testid="desktop-agent-rail"
      className="fixed right-4 top-1/2 z-30 -translate-y-1/2"
    >
      <FloatingRail>
        {showGitActions && (
          <HeaderActions virtualMcpId={virtualMcpId} variant="rail" />
        )}
        {reviewChangesTab && (
          <RailTabButton
            tab={reviewChangesTab}
            active={isTabActive(reviewChangesTab)}
            locked={sidePanel === null && isTabActive(reviewChangesTab)}
            onClick={() => handleSelect(reviewChangesTab)}
          />
        )}

        {showGitGroup && <FloatingRailDivider />}

        <FloatingRailIconButton
          label="Chat"
          active={sidePanel === "chat"}
          locked={sidePanel === "chat" && !mainOpen}
          onClick={() => {
            track("agent_toolbar_toggled", {
              button: "chat",
              next_state: sidePanel === "chat" ? "closed" : "open",
              surface: "floating_rail",
            });
            toggleSidePanel("chat");
          }}
        >
          <MessageCircle01 className="size-4" />
        </FloatingRailIconButton>
        <FloatingRailIconButton
          label="Library"
          active={library.active}
          disabled={!library.enabled}
          onClick={library.toggle}
        >
          <Folder className="size-4" />
        </FloatingRailIconButton>
        {taskBoardEnabled && (
          <FloatingRailIconButton
            label="Tasks"
            active={tasks.active}
            disabled={!tasks.enabled}
            onClick={tasks.toggle}
          >
            <Columns03 className="size-4" />
          </FloatingRailIconButton>
        )}

        <FloatingRailDivider />

        {agentTabs.map((tab) => {
          const active = isTabActive(tab);
          if (tab.id !== "preview") {
            return (
              <RailTabButton
                key={tab.id}
                tab={tab}
                active={active}
                locked={sidePanel === null && active}
                onClick={() => handleSelect(tab)}
              />
            );
          }

          return (
            <div
              key={tab.id}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-full p-0.5 transition-colors",
                active && "bg-primary/10",
              )}
            >
              <RailTabButton
                tab={tab}
                active={active}
                locked={sidePanel === null && active}
                onClick={() => handleSelect(tab)}
              />
              <div
                ref={railPortal?.setPreviewControlsEl}
                className="contents"
              />
            </div>
          );
        })}
      </FloatingRail>
    </div>
  );
}
