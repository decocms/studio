import {
  AlignLeft01,
  AlignRight01,
  Code01,
  LayoutRight,
  MessageCircle01,
  PuzzlePiece01,
} from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { HeaderTabButton } from "@/layouts/main-panel-tabs/header-tab-button";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t";
import { TOUR_ANCHORS } from "@/components/cms-tour/anchors";
import type { SidePanelKind } from "@/hooks/use-layout-state";

export interface ChatToggleProps {
  sidePanel: SidePanelKind | null;
  toggleSidePanel: (sidePanel: SidePanelKind) => void;
  /**
   * When true, the active chat toggle is disabled because closing it would
   * leave a blank content area (chat is the only open panel).
   */
  disableActiveSidePanelToggle?: boolean;
}

export interface CodeToggleProps extends ChatToggleProps {
  /** The draft has no dev environment yet, so opening this one provisions it. */
  needsDevEnvironment: boolean;
  /** Provision it. Called before the panel opens; safe to call while pending. */
  onStart: () => void;
}

/**
 * Chat toggle — opens / closes the chat side panel. Rendered through the shared
 * HeaderTabButton so it stays pixel-identical to the Main panel tabs. It lives
 * in the chat panel's own header while the chat is open, and relocates into the
 * remaining panel's header when the chat is closed, so it never disappears.
 */
export function ChatToggle({
  sidePanel,
  toggleSidePanel,
  disableActiveSidePanelToggle = false,
}: ChatToggleProps) {
  const t = useT();
  return (
    <HeaderTabButton
      title={t("agentShellLayout.toggleButtons.chat")}
      icon={{ kind: "component", Component: MessageCircle01 }}
      active={sidePanel === "chat"}
      disabled={disableActiveSidePanelToggle && sidePanel === "chat"}
      // Distinctive icon — collapses with the system tabs at 768px of header.
      labelCollapse="sooner"
      className="h-10 md:h-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
      onClick={() => {
        track("agent_toolbar_toggled", {
          button: "chat",
          next_state: sidePanel === "chat" ? "closed" : "open",
        });
        toggleSidePanel("chat");
      }}
    />
  );
}

/**
 * CMS toggle — the side-panel occupant on projects where CMS mode is available.
 * A sibling of {@link ChatToggle} rather than a branch inside it, so neither
 * surface has to reason about the other's project type.
 *
 * It carries `TOUR_ANCHORS.edit`, which the CMS tour uses as its readiness gate
 * — the anchor moved here from the preview toolbar's Edit-content button.
 */
export function CmsToggle({
  sidePanel,
  toggleSidePanel,
  disableActiveSidePanelToggle = false,
}: ChatToggleProps) {
  const t = useT();
  return (
    <HeaderTabButton
      title={t("agentShellLayout.toggleButtons.cms")}
      icon={{ kind: "component", Component: PuzzlePiece01 }}
      active={sidePanel === "cms"}
      disabled={disableActiveSidePanelToggle && sidePanel === "cms"}
      labelCollapse="sooner"
      dataTour={TOUR_ANCHORS.edit}
      className="h-10 md:h-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
      onClick={() => {
        track("agent_toolbar_toggled", {
          button: "cms",
          next_state: sidePanel === "cms" ? "closed" : "open",
        });
        toggleSidePanel("cms");
      }}
    />
  );
}

/**
 * Code toggle — the vibecoding half of the CMS/Code pair, shown only on
 * projects that have both. It is the SWITCH: on a draft with no dev
 * environment, clicking it provisions one and opens the agent chat, so the two
 * modes are one click apart in both directions.
 *
 * A plain {@link ChatToggle} can't do this job — it renders as "Chat", which
 * reads as a feature rather than a mode, and a CMS draft has no chat to open
 * until a pod exists. Labelling it "Code" is what makes the pair legible as
 * two modes of the same draft.
 */
export function CodeToggle({
  sidePanel,
  toggleSidePanel,
  disableActiveSidePanelToggle = false,
  needsDevEnvironment,
  onStart,
}: CodeToggleProps) {
  const t = useT();
  return (
    <HeaderTabButton
      title={t("agentShellLayout.toggleButtons.code")}
      icon={{ kind: "component", Component: Code01 }}
      active={sidePanel === "chat"}
      disabled={disableActiveSidePanelToggle && sidePanel === "chat"}
      labelCollapse="sooner"
      className="h-10 md:h-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
      onClick={() => {
        track("agent_toolbar_toggled", {
          button: "code",
          next_state: sidePanel === "chat" ? "closed" : "open",
        });
        // Provision first: the panel it opens is the agent composer, which
        // stays a "Start coding" prompt until the branch has a pod.
        if (needsDevEnvironment && sidePanel !== "chat") onStart();
        toggleSidePanel("chat");
      }}
    />
  );
}

/**
 * A panel collapse control — the pair of chevron-into-bar buttons that bracket
 * the workspace under the first-class navigation: the left one lives at the
 * start of the MAIN header and hides/shows the chat, the right one lives at the
 * end of the CHAT header and hides/shows the main panel.
 *
 * Deliberately a plain icon button, not a HeaderTabButton: these are chrome for
 * the panel itself, not one of its views, so they never take the tab's active
 * pill styling.
 */
export function PanelCollapseToggle({
  side,
  open,
  disabled,
  onToggle,
}: {
  side: "left" | "right";
  open: boolean;
  /** True when collapsing would leave no panel showing at all. */
  disabled?: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const label = open
    ? side === "left"
      ? t("agentShellLayout.toggleButtons.hideChat")
      : t("agentShellLayout.toggleButtons.hidePanel")
    : side === "left"
      ? t("agentShellLayout.toggleButtons.showChat")
      : t("agentShellLayout.toggleButtons.showPanel");
  const Icon =
    side === "right" ? LayoutRight : open ? AlignLeft01 : AlignRight01;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          disabled={disabled}
          onClick={() => {
            track("agent_toolbar_toggled", {
              button: side === "left" ? "chat" : "main",
              next_state: open ? "closed" : "open",
            });
            onToggle();
          }}
          className="size-7 rounded-md disabled:opacity-40"
        >
          <Icon size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
