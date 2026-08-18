import {
  AlignLeft01,
  AlignRight01,
  Code01,
  Grid01,
  LayoutRight,
  MessageCircle01,
} from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { SplitButton } from "@decocms/ui/components/split-button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { CmsEditingMode } from "@/sdk/cms-mode";
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

export interface ModeSplitButtonProps {
  /** The panel's occupant, or null while it is closed. */
  sidePanel: SidePanelKind | null;
  /** The occupant the body toggles — the live one, or the remembered one while
   *  the panel is closed (`?sidepanel=0` keeps no kind). */
  mode: SidePanelKind;
  toggleSidePanel: (sidePanel: SidePanelKind) => void;
  /** Opens without the toggle's close-on-same-kind behaviour: picking the mode
   *  you are already in must not collapse the panel. */
  openSidePanel: (sidePanel: SidePanelKind) => void;
  /** Records the choice in `?mode=`. The mode governs the whole workspace —
   *  preview origin, view tabs, console — so picking one has to outlive the
   *  side panel that revealed it. */
  setEditingMode: (mode: CmsEditingMode) => void;
  /** The draft has no dev environment yet, so choosing vibecoding provisions it. */
  needsDevEnvironment: boolean;
  /** Provision it. Called before the panel opens; safe to call while pending. */
  onStart: () => void;
  disableActiveSidePanelToggle?: boolean;
  className?: string;
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
 * The mode control — one split button standing in for the CMS/vibecoding pair.
 *
 *   body  → collapse or reopen the side panel, on the mode it already shows
 *   caret → choose the mode
 *
 * That division is deliberate. Collapsing is a many-times-a-session action and
 * gets the wide target; choosing a mode happens about once per draft and sits
 * behind a caret, which is the only thing a caret has ever meant. The earlier
 * arrangement — two tab buttons — read as two features rather than two modes of
 * one draft, and had nowhere to say that vibecoding must first be provisioned.
 *
 * `mode` is passed in rather than read off `sidePanel`, which goes null when the
 * panel closes: the body has to keep toggling the occupant the user left.
 */
export function ModeSplitButton({
  sidePanel,
  mode,
  toggleSidePanel,
  openSidePanel,
  setEditingMode,
  needsDevEnvironment,
  onStart,
  disableActiveSidePanelToggle = false,
  className,
}: ModeSplitButtonProps) {
  const t = useT();
  const isCms = mode === "cms";
  const pick = (kind: SidePanelKind) => {
    track("agent_toolbar_mode_picked", { mode: kind });
    // Provision before opening: the panel it reveals is the agent composer,
    // which stays a "start vibecoding" prompt until the branch has a pod.
    if (kind === "chat" && needsDevEnvironment) onStart();
    setEditingMode(kind === "cms" ? "cms" : "vibecoding");
    openSidePanel(kind);
  };

  return (
    <SplitButton
      variant="outline"
      size="sm"
      label={t(
        isCms
          ? "agentShellLayout.toggleButtons.cms"
          : "agentShellLayout.toggleButtons.vibecoding",
      )}
      icon={
        isCms ? (
          <Grid01 className="size-3.5" />
        ) : (
          <Code01 className="size-3.5" />
        )
      }
      disabled={disableActiveSidePanelToggle && sidePanel === mode}
      onClick={() => {
        track("agent_toolbar_toggled", {
          button: mode === "cms" ? "cms" : "vibecoding",
          next_state: sidePanel === mode ? "closed" : "open",
        });
        toggleSidePanel(mode);
      }}
      menuAriaLabel={t("agentShellLayout.toggleButtons.chooseMode")}
      dataTour={TOUR_ANCHORS.edit}
      className={cn("h-10 md:h-7", className)}
      items={[
        {
          key: "cms",
          icon: <Grid01 className="size-3.5" />,
          label: t("agentShellLayout.toggleButtons.cms"),
          description: t("agentShellLayout.toggleButtons.cmsDescription"),
          selected: isCms,
          onSelect: () => pick("cms"),
        },
        {
          key: "chat",
          icon: <Code01 className="size-3.5" />,
          label: t(
            needsDevEnvironment
              ? "agentShellLayout.toggleButtons.startVibecoding"
              : "agentShellLayout.toggleButtons.vibecoding",
          ),
          description: t(
            needsDevEnvironment
              ? "agentShellLayout.toggleButtons.startVibecodingDescription"
              : "agentShellLayout.toggleButtons.vibecodingDescription",
          ),
          selected: !isCms,
          onSelect: () => pick("chat"),
        },
      ]}
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
