/**
 * The two presentational bits both view lists share: a view's glyph, and the
 * row's trailing controls (pin state + menu).
 */

import {
  ArrowUpRight,
  BarChartSquare02,
  CheckDone01,
  Columns03,
  DotsVertical,
  Globe02,
  Home02,
  Image01,
  Lightning01,
  Monitor01,
  Pin01,
  Server01,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { ProjectSidebarViewId } from "@/layouts/main-panel-tabs/project-sidebar-views";

export function SidebarViewIcon({ viewId }: { viewId: ProjectSidebarViewId }) {
  if (viewId === "overview") return <Home02 size={16} />;
  if (viewId === "reports") return <BarChartSquare02 size={16} />;
  if (viewId === "board") return <Columns03 size={16} />;
  if (viewId === "site-editor") return <Monitor01 size={16} />;
  if (viewId === "assets") return <Image01 size={16} />;
  if (viewId === "hosting") return <Server01 size={16} />;
  if (viewId === "e2e") return <CheckDone01 size={16} />;
  if (viewId === "analytics") return <BarChartSquare02 size={16} />;
  if (viewId === "cdn") return <Globe02 size={16} />;
  return <Lightning01 size={16} />;
}

/**
 * A view's row actions: the pin state as a glyph, and the menu that changes it.
 *
 * Pinning used to be a switch, which made the sidebar the only way IN to a
 * view — turn it off and the view was unreachable. Opening is the row itself
 * now, so the sidebar is a shortcut you grant, not the door.
 */
export function ViewRowActions({
  pinned,
  canSetMainView,
  onOpen,
  onTogglePin,
  onSetMainView,
}: {
  pinned: boolean;
  canSetMainView: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onSetMainView: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-1">
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "size-7",
              pinned ? "text-foreground" : "text-muted-foreground/40",
            )}
            aria-label={
              pinned
                ? t("virtualMcp.settings.views.unpin")
                : t("virtualMcp.settings.views.pin")
            }
            aria-pressed={pinned}
            onClick={onTogglePin}
          >
            <Pin01 size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {pinned
            ? t("virtualMcp.settings.views.unpin")
            : t("virtualMcp.settings.views.pin")}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label={t("virtualMcp.settings.views.rowActions")}
          >
            <DotsVertical size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onOpen}>
            <ArrowUpRight size={14} />
            {t("virtualMcp.settings.views.open")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onTogglePin}>
            <Pin01 size={14} />
            {pinned
              ? t("virtualMcp.settings.views.unpin")
              : t("virtualMcp.settings.views.pin")}
          </DropdownMenuItem>
          {canSetMainView && (
            <DropdownMenuItem onClick={onSetMainView}>
              <Home02 size={14} />
              {t("virtualMcp.settings.views.setMainView")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
