/**
 * Shell breadcrumb — the org switcher in the toolbar's top-left.
 *
 * The active organization's own icon *is* the switcher (Slack-style).
 * Icon-only; the org name shows on hover. Opens the org switcher popover;
 * selecting the current org returns to its home.
 *
 * Renders inside `Toolbar.LeftColumn` — see `org-shell-layout`.
 */
import { ChevronDown } from "@untitledui/icons";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
} from "@deco/ui/components/breadcrumb.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  OrgIcon,
  OrgSwitcherPopover,
} from "@/web/components/header/org-switcher";
import { usePendingInvitations } from "@/web/hooks/use-pending-invitations";

export function ShellBreadcrumb() {
  const { org } = useProjectContext();
  const { state: sidebarState, isMobile } = useSidebar();
  // Pending cross-org invitations surface inside the org switcher; show a dot on
  // its trigger so they're noticed without opening it.
  const hasPendingInvites = usePendingInvitations().invitations.length > 0;
  const isSidebarCollapsed = sidebarState === "collapsed" || isMobile;

  return (
    <Breadcrumb className="wco-no-drag">
      <BreadcrumbList className="flex-nowrap gap-1.5 sm:gap-1.5">
        {/* org icon = switcher (Slack-style). Icon-only; the name is on hover.
            The deco/product brand logo intentionally no longer lives here — the
            org's own identity anchors the top-left. */}
        <BreadcrumbItem>
          <Tooltip>
            <OrgSwitcherPopover
              orgParam={org.slug}
              trigger={
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={
                      hasPendingInvites
                        ? `${org.name} — switch organization (pending invitation)`
                        : `${org.name} — switch organization`
                    }
                    // Extra left padding centers the org icon over the 56px
                    // collapsed sidebar rail below it (icons sit at ~28px from
                    // the shared left edge), so it lines up when the sidebar is
                    // closed.
                    className="wco-no-drag flex items-center gap-1.5 shrink-0 rounded-md pl-3 pr-1.5 py-1.5 hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="relative inline-flex">
                      <OrgIcon org={org} size="sm" />
                      {hasPendingInvites && (
                        <span
                          className={cn(
                            "absolute -right-1 size-2.5 rounded-full bg-destructive ring-2 ring-background",
                            isSidebarCollapsed
                              ? "-top-1"
                              : "top-1/2 -translate-y-1/2",
                          )}
                        />
                      )}
                    </span>
                    <ChevronDown
                      size={14}
                      className="shrink-0 text-muted-foreground opacity-70"
                    />
                  </button>
                </TooltipTrigger>
              }
            />
            <TooltipContent side="bottom">{org.name}</TooltipContent>
          </Tooltip>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
