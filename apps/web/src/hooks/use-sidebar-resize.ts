import { useCompactPageLayout } from "@/hooks/use-preferences";
import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";

const SIDEBAR_MAX_WIDTH = 400;
const KEYBOARD_STEP = 16;
const STORAGE_KEY = "sidebar.width";

export interface SidebarResize {
  width: number;
  minWidth: number;
  maxWidth: number;
  wrapperRef: RefObject<HTMLDivElement | null>;
  onStartResize: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDownResize: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  resetWidth: () => void;
}

/**
 * Resizable sidebar width with min/max clamping and localStorage persistence.
 *
 * During drag, mutates `--sidebar-width` directly on the wrapper ref to avoid
 * per-frame React renders. On release, commits the final value to React state
 * (and localStorage).
 */
export function useSidebarResize(): SidebarResize {
  const compact = useCompactPageLayout();
  const minWidth = compact ? 224 : 240;
  const clamp = (w: number) =>
    Math.max(minWidth, Math.min(SIDEBAR_MAX_WIDTH, w));
  const [width, setWidth] = useLocalStorage<number>(STORAGE_KEY, (existing) =>
    typeof existing === "number" ? clamp(existing) : minWidth,
  );
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const onStartResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = clamp(width);
    const wrapper =
      wrapperRef.current ??
      (typeof document !== "undefined"
        ? document.querySelector<HTMLDivElement>(
            '[data-slot="sidebar-wrapper"]',
          )
        : null);
    // Disable the sidebar's width transitions for the duration of the drag so
    // the rail follows the cursor instead of easing toward each new width.
    const transitionTargets = wrapper
      ? Array.from(
          wrapper.querySelectorAll<HTMLElement>(
            '[data-slot="sidebar"], [data-slot="sidebar-container"]',
          ),
        )
      : [];
    for (const el of transitionTargets) {
      el.style.transition = "none";
    }

    const handleMove = (ev: PointerEvent) => {
      const next = clamp(startWidth + (ev.clientX - startX));
      wrapper?.style.setProperty("--sidebar-width", `${next}px`);
    };

    const handleUp = (ev: PointerEvent) => {
      const final = clamp(startWidth + (ev.clientX - startX));
      setWidth(final);
      for (const el of transitionTargets) {
        el.style.transition = "";
      }
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  };

  const resetWidth = () => {
    setWidth(minWidth);
  };

  // ARIA window-splitter keys: arrows step, Home/End jump to the ends.
  const onKeyDownResize = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setWidth(clamp(width - KEYBOARD_STEP));
    else if (e.key === "ArrowRight") setWidth(clamp(width + KEYBOARD_STEP));
    else if (e.key === "Home") setWidth(minWidth);
    else if (e.key === "End") setWidth(SIDEBAR_MAX_WIDTH);
    else return;
    e.preventDefault();
  };

  return {
    width: clamp(width),
    minWidth,
    maxWidth: SIDEBAR_MAX_WIDTH,
    wrapperRef,
    onStartResize,
    onKeyDownResize,
    resetWidth,
  };
}
