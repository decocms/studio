import {
  createContext,
  use,
  useRef,
  type MouseEvent,
  type PropsWithChildren,
} from "react";
import { LayoutLeft, MessageCircle01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t";

type PanelToggleState = {
  panel: "chat" | "main";
  open: boolean;
};

interface PanelToggleFocusContextValue {
  request: (target: PanelToggleState) => void;
  claim: (node: HTMLButtonElement, target: PanelToggleState) => void;
}

const PanelToggleFocusContext =
  createContext<PanelToggleFocusContextValue | null>(null);

/**
 * Coordinates focus between the two physical instances of a semantic toggle.
 * Main's control lives in Main while open and in Chat while closed (and vice
 * versa for Chat), so normal browser focus restoration cannot follow it.
 */
export function PanelToggleFocusProvider({ children }: PropsWithChildren) {
  const pendingRef = useRef<PanelToggleState | null>(null);
  const value: PanelToggleFocusContextValue = {
    request: (target) => {
      pendingRef.current = target;
    },
    claim: (node, target) => {
      const pending = pendingRef.current;
      if (
        pending?.panel !== target.panel ||
        pending.open !== target.open ||
        node.closest("[inert]") ||
        node.getClientRects().length === 0
      ) {
        return;
      }
      pendingRef.current = null;
      node.focus({ preventScroll: true });
    },
  };

  return (
    <PanelToggleFocusContext value={value}>{children}</PanelToggleFocusContext>
  );
}

/**
 * An icon-only control for one semantic workspace panel. Placement is owned by
 * the header composing it: Main lives on the left and Chat lives on the right,
 * so their controls can sit next to the outer edge of the panel they affect.
 *
 * Deliberately a plain icon button, not a HeaderTabButton: these are chrome for
 * the panel itself, not one of its views, so they never take the tab's active
 * pill styling.
 */
export function PanelCollapseToggle({
  panel,
  open,
  disabled,
  onToggle,
}: {
  panel: "chat" | "main";
  open: boolean;
  /** True when collapsing would leave no panel showing at all. */
  disabled?: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const focus = use(PanelToggleFocusContext);
  const label = open
    ? panel === "chat"
      ? t("agentShellLayout.toggleButtons.hideChat")
      : t("agentShellLayout.toggleButtons.hidePanel")
    : panel === "chat"
      ? t("agentShellLayout.toggleButtons.showChat")
      : t("agentShellLayout.toggleButtons.showPanel");
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    track("agent_toolbar_toggled", {
      button: panel,
      next_state: open ? "closed" : "open",
    });
    // The active instance is about to disappear or become inert. Ask the
    // newly-visible instance to claim focus during its commit for both keyboard
    // and pointer activation; browsers cannot preserve focus across two nodes.
    if (
      event.currentTarget.ownerDocument.activeElement === event.currentTarget
    ) {
      focus?.request({ panel, open: !open });
    }
    onToggle();
  };
  const Icon = panel === "chat" ? MessageCircle01 : LayoutLeft;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          ref={(node) => {
            if (node) focus?.claim(node, { panel, open });
          }}
          aria-label={label}
          aria-controls={
            panel === "chat" ? "workspace-side-panel" : "workspace-main-panel"
          }
          aria-expanded={open}
          disabled={disabled}
          onClick={onClick}
          className="size-7 rounded-md disabled:opacity-40"
        >
          <Icon size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
