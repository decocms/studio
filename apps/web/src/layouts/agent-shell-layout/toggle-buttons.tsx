import { LayoutRight, MessageCircle01 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  panelButtonChrome,
  ToolbarIconButton,
} from "@/components/toolbar-icon-button";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t";

/**
 * A panel collapse control bracketing the workspace: the left one lives at
 * the start of the MAIN header and hides/shows the chat (chat-bubble icon),
 * the right one lives at the end of the CHAT header and hides/shows the main
 * panel (chevron-into-bar icon).
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
  const onClick = () => {
    track("agent_toolbar_toggled", {
      button: side === "left" ? "chat" : "main",
      next_state: open ? "closed" : "open",
    });
    onToggle();
  };

  // The chat toggle spells out its label; the main-panel toggle stays icon-only.
  if (side === "left") {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex h-10 md:h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm disabled:opacity-40",
          panelButtonChrome(),
        )}
      >
        <MessageCircle01 size={16} />
        {label}
      </button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="size-7 rounded-md disabled:opacity-40"
        >
          <LayoutRight size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
