import { useState } from "react";
import { Monitor01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import {
  ConnectDesktopDialog,
  visibleCapabilities,
} from "@/web/components/chat/connect-desktop-dialog";

export function LinkedDesktopIndicator() {
  const link = useCurrentLink();
  const [dialogOpen, setDialogOpen] = useState(false);

  const labels = visibleCapabilities(link.capabilities);
  const tooltipContent = link.online ? (
    <div className="flex flex-col gap-0.5 text-xs">
      <span className="font-medium">{link.machineId ?? "Desktop linked"}</span>
      <span className="text-muted-foreground">
        {labels.length > 0
          ? `Available: ${labels.join(", ")}`
          : "No CLI agents detected"}
      </span>
    </div>
  ) : (
    <span className="text-xs">Desktop disconnected</span>
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            aria-label={link.online ? "Desktop linked" : "Connect your desktop"}
            className="relative flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            <Monitor01 size={16} />
            {link.online && (
              <span className="absolute top-1 right-1 size-2 rounded-full bg-success ring-2 ring-background animate-pulse" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipContent}</TooltipContent>
      </Tooltip>
      <ConnectDesktopDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
