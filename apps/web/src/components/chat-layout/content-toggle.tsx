import { LayoutRight } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t";

/** The conversation toolbar can expand chat to fill the content area. */
export function ContentToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const label = t(
    open
      ? "agentShellLayout.toggleButtons.hidePanel"
      : "agentShellLayout.toggleButtons.showPanel",
  );
  const onClick = () => {
    track("agent_toolbar_toggled", {
      button: "main",
      next_state: open ? "closed" : "open",
    });
    onToggle();
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
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
