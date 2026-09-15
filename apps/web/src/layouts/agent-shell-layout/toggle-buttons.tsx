import { LayoutRight, MessageCircle01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { cn } from "@decocms/ui/lib/utils.ts";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t";

type PanelVisibilityToggleProps = {
  onToggle: () => void;
  panel: "chat" | "main";
  open: boolean;
};

/**
 * Chat toggles from the sidebar; Main toggles from its header or Chat.
 */
export function PanelVisibilityToggle({
  panel,
  open,
  onToggle,
}: PanelVisibilityToggleProps) {
  const t = useT();
  const label =
    panel === "main"
      ? open
        ? t("agentShellLayout.toggleButtons.hidePanel")
        : t("agentShellLayout.toggleButtons.showPanel")
      : open
        ? t("agentShellLayout.toggleButtons.hideChat")
        : t("agentShellLayout.toggleButtons.showChat");
  const onClick = () => {
    track("agent_toolbar_toggled", {
      button: panel,
      next_state: open ? "closed" : "open",
    });
    onToggle();
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          aria-controls={
            panel === "chat" ? "workspace-side-panel" : "workspace-main-panel"
          }
          aria-expanded={open}
          aria-pressed={panel === "chat" ? open : undefined}
          data-responsive-focus-group={
            panel === "chat" ? "main-route-navigation" : undefined
          }
          active={open}
          onClick={onClick}
          className={cn(
            panel === "chat"
              ? "rounded-lg md:size-[34px]"
              : "size-7 rounded-md",
          )}
        >
          {panel === "chat" ? (
            <MessageCircle01 size={16} />
          ) : (
            <LayoutRight size={16} />
          )}
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side={panel === "chat" ? "right" : "bottom"}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
