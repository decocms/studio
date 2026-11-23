import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { Share07 } from "@untitledui/icons";
import { useLocation } from "@tanstack/react-router";
import { InviteLinkPanel } from "@/components/invite-link-panel";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useCanShareInviteLinks } from "@/hooks/use-invite-links";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContextOptional } from "@/sdk";

function SharePagePopover({ orgName }: { orgName: string }) {
  const t = useT();
  const location = useLocation();
  const canShare = useCanShareInviteLinks();
  if (!canShare) return null;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ToolbarIconButton aria-label={t("common.sharePage.button")}>
              <Share07 size={16} />
            </ToolbarIconButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("common.sharePage.button")}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("common.sharePage.title")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("common.sharePage.description", { orgName })}
            </span>
          </div>
          {/* Remount per page so a link made on one page is not shown on another. */}
          <InviteLinkPanel
            key={location.href}
            role="user"
            redirectPath={location.href}
            source="share_button"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Lets members managers hand the current page to someone outside the org:
 * the link signs them in, joins them, and opens this page.
 */
export function SharePageButton() {
  const project = useProjectContextOptional();
  if (!project?.org.id) return null;
  return <SharePagePopover orgName={project.org.name} />;
}
