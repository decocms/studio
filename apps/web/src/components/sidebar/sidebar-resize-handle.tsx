import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useT } from "@/i18n/use-t.ts";

/**
 * Vertical handle positioned at the sidebar's right edge that lets the user
 * drag-resize the sidebar width, or resize it with the arrow/Home/End keys
 * once focused. Hidden when the sidebar is collapsed (icon rail mode) or on
 * mobile.
 *
 * Hit area is wider than the visible line so it's easy to grab. The visible
 * line is subtle until hover/drag, then thickens and brightens.
 */
export function SidebarResizeHandle({
  width,
  minWidth,
  maxWidth,
  onPointerDown,
  onKeyDown,
  onDoubleClick,
}: {
  width: number;
  minWidth: number;
  maxWidth: number;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
}) {
  const t = useT();
  const { isMobile } = useSidebar();
  const collapsed = useSidebarCollapsed();
  if (isMobile || collapsed) return null;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("sidebar.sidebarResizeHandle.ariaLabel")}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      title={t("sidebar.sidebarResizeHandle.title")}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      className="group/resize absolute top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize focus-visible:outline-none"
      style={{ left: "var(--sidebar-width)" }}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover/resize:bg-border group-active/resize:bg-border group-focus-visible/resize:bg-ring" />
    </div>
  );
}
