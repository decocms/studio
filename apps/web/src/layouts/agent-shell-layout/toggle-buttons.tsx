import { LayoutLeft, MessageCircle01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t";

type PanelVisibilityToggleProps = {
  onToggle: () => void;
} & ({ panel: "chat"; open: boolean } | { panel: "main"; open: false });

/**
 * An icon-only visibility control for workspace chrome. Chat can be toggled
 * from Main; a hidden Main can be restored from Chat. Main intentionally has
 * no matching hide button in its topbar.
 *
 * Deliberately a plain icon button, not a HeaderTabButton: these are chrome for
 * the panel itself, not one of its views, so they never take the tab's active
 * pill styling.
 */
export function PanelVisibilityToggle({
  panel,
  open,
  onToggle,
}: PanelVisibilityToggleProps) {
  const t = useT();
  const label =
    panel === "main"
      ? t("agentShellLayout.toggleButtons.showPanel")
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
  const Icon = panel === "chat" ? MessageCircle01 : LayoutLeft;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          aria-controls={
            panel === "chat" ? "workspace-side-panel" : "workspace-main-panel"
          }
          aria-expanded={open}
          onClick={onClick}
          className="size-7 rounded-md"
        >
          <Icon size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
