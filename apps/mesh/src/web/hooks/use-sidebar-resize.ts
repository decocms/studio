import {
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useLocalStorage } from "@/web/hooks/use-local-storage";

const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 400;
const STORAGE_KEY = "sidebar.width";

function clamp(w: number) {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w));
}

export interface SidebarResize {
  width: number;
  wrapperRef: RefObject<HTMLDivElement | null>;
  onStartResize: (e: ReactPointerEvent<HTMLDivElement>) => void;
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
  const [width, setWidth] = useLocalStorage<number>(STORAGE_KEY, (existing) =>
    typeof existing === "number" ? clamp(existing) : SIDEBAR_MIN_WIDTH,
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
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const resetWidth = () => {
    setWidth(SIDEBAR_MIN_WIDTH);
  };

  return { width: clamp(width), wrapperRef, onStartResize, resetWidth };
}
