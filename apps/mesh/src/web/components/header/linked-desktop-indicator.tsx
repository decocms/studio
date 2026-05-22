import { useState } from "react";
import { Monitor01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
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
    <span className="text-xs">
      Run <code className="font-mono">bunx decocms link</code> on your desktop
    </span>
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            aria-label={link.online ? "Desktop linked" : "Connect your desktop"}
            className={cn(
              "flex items-center gap-1.5 h-7 px-2 rounded-md transition-colors",
              "hover:bg-sidebar-accent",
              link.online
                ? "text-sidebar-foreground/70 hover:text-sidebar-foreground"
                : "text-sidebar-foreground hover:text-sidebar-foreground",
            )}
          >
            <span className="relative inline-flex items-center justify-center">
              <Monitor01 size={16} />
              {link.online && (
                <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-success ring-2 ring-background" />
              )}
            </span>
            <span className="text-xs font-medium">
              {link.online ? "Desktop" : "Connect desktop"}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipContent}</TooltipContent>
      </Tooltip>
      <ConnectDesktopDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
