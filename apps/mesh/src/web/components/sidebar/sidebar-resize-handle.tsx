import type { PointerEvent as ReactPointerEvent } from "react";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";

/**
 * Vertical handle positioned at the sidebar's right edge that lets the user
 * drag-resize the sidebar width. Hidden when the sidebar is collapsed (icon
 * rail mode) or on mobile.
 *
 * Hit area is wider than the visible line so it's easy to grab. The visible
 * line is subtle until hover/drag, then thickens and brightens.
 */
export function SidebarResizeHandle({
  onPointerDown,
  onDoubleClick,
}: {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
}) {
  const { state, isMobile } = useSidebar();
  if (isMobile || state === "collapsed") return null;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className="group/resize absolute top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize"
      style={{ left: "var(--sidebar-width)" }}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover/resize:bg-border group-active/resize:bg-border" />
    </div>
  );
}
