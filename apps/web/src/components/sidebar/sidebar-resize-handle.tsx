import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import { useT } from "@/i18n/use-t.ts";
import { SIDEBAR_RESIZE_KEYBOARD_STEP } from "@/hooks/use-sidebar-resize";

/**
 * Vertical handle positioned at the sidebar's right edge that lets the user
 * drag-resize the sidebar width. Hidden when the sidebar is collapsed (icon
 * rail mode) or on mobile.
 *
 * Hit area is wider than the visible line so it's easy to grab. The visible
 * line is subtle until hover/drag, then thickens and brightens. Also
 * keyboard-operable: focus it and use the arrow keys (or Home/End) to resize,
 * matching the WAI-ARIA APG pattern for a separator that moves its sibling.
 */
export function SidebarResizeHandle({
  width,
  minWidth,
  maxWidth,
  onPointerDown,
  onDoubleClick,
  onAdjustWidth,
  onResetWidth,
}: {
  width: number;
  minWidth: number;
  maxWidth: number;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
  onAdjustWidth: (delta: number) => void;
  onResetWidth?: () => void;
}) {
  const t = useT();
  const { state, isMobile } = useSidebar();
  if (isMobile || state === "collapsed") return null;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        onAdjustWidth(-SIDEBAR_RESIZE_KEYBOARD_STEP);
        break;
      case "ArrowRight":
        e.preventDefault();
        onAdjustWidth(SIDEBAR_RESIZE_KEYBOARD_STEP);
        break;
      case "Home":
        e.preventDefault();
        onAdjustWidth(minWidth - width);
        break;
      case "End":
        e.preventDefault();
        onAdjustWidth(maxWidth - width);
        break;
      case "Enter":
        onResetWidth?.();
        break;
      default:
        break;
    }
  };

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
      onDoubleClick={onDoubleClick}
      onKeyDown={handleKeyDown}
      className="group/resize absolute top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ left: "var(--sidebar-width)" }}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover/resize:bg-border group-active/resize:bg-border" />
    </div>
  );
}
