import { DEFAULT_LOGO, usePublicConfig } from "@/web/hooks/use-public-config";
import { SidebarHeader } from "@deco/ui/components/sidebar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { LayoutLeft } from "@untitledui/icons";
import { LinkedDesktopIndicator } from "@/web/components/header/linked-desktop-indicator";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { Link } from "@tanstack/react-router";

interface SidebarLogoHeaderProps {
  /** Collapse / close the sidebar. */
  onToggle: () => void;
  className?: string;
  /** Whether to show the linked-desktop indicator. Defaults to true. */
  showDesktopIndicator?: boolean;
  /** When provided, wraps the logo in a link back to the org home. */
  orgSlug?: string;
}

/**
 * Logo + sidebar-collapse toggle + linked-desktop indicator rendered at the top
 * of the sidebar panel. Pixel-matches the shell toolbar header (logo, trigger,
 * desktop indicator), so the row lines up with the header at every breakpoint:
 *
 *   - Row: `h-12`, `pt-0.25`, vertically centered (mirrors `ToolbarHeader`).
 *     We must set every padding side explicitly because `SidebarHeader`
 *     defaults to `p-2`, which would otherwise push the row down.
 *   - Logo left edge sits at 1rem: container `pl-1` + logo wrapper `pl-1` +
 *     inner `px-2` — the same nesting as `ToolbarLogoLink` > `ToolbarLogoInner`.
 *   - Gap: `gap-2` on mobile / `gap-0.5` on desktop (mobile header grid gap vs
 *     desktop `ToolbarLeftColumn` gap).
 *   - Buttons use `ToolbarIconButton` (`size-10 md:size-7`) — the exact button
 *     used by the header trigger and the desktop indicator.
 */
export function SidebarLogoHeader({
  onToggle,
  className,
  showDesktopIndicator = true,
  orgSlug,
}: SidebarLogoHeaderProps) {
  const config = usePublicConfig();
  const logo = config.logo ?? DEFAULT_LOGO;
  const lightSrc = typeof logo === "string" ? logo : logo.light;
  const darkSrc = typeof logo === "string" ? logo : logo.dark;

  const logoImages = (
    <span className="flex items-center shrink-0 px-2">
      <img
        src={lightSrc}
        alt="Logo"
        className="size-6 object-contain dark:hidden"
      />
      <img
        src={darkSrc}
        alt="Logo"
        className="size-6 object-contain hidden dark:block"
      />
    </span>
  );

  return (
    <SidebarHeader
      className={cn(
        "flex flex-row items-center gap-1 md:gap-0.5 shrink-0 h-12 pl-1 pr-2 pt-0.25 pb-0",
        // The desktop sidebar collapses to a narrow icon rail where a logo +
        // toggle row can't fit; hide it there (the toolbar trigger reopens it).
        // The mobile drawer is always expanded, so it stays visible.
        "group-data-[collapsible=icon]/sidebar:hidden",
        className,
      )}
    >
      {orgSlug ? (
        <Link
          to="/$org"
          params={{ org: orgSlug }}
          aria-label="Back to home"
          className="flex items-center shrink-0 pl-1"
        >
          {logoImages}
        </Link>
      ) : (
        <span className="flex items-center shrink-0 pl-1">{logoImages}</span>
      )}
      <ToolbarIconButton onClick={onToggle} aria-label="Toggle sidebar">
        <LayoutLeft size={16} />
      </ToolbarIconButton>
      {showDesktopIndicator && <LinkedDesktopIndicator />}
    </SidebarHeader>
  );
}
