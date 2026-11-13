import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useRef } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { clampEditorShare, POST_EDITOR_SHARE } from "./post-split-layout";

const STORAGE_KEY = "blog.postSplit.editorShare.v1";
const KEYBOARD_STEP = 5;

/** The CSS variable the editor pane's width reads, as a percentage. */
export const EDITOR_WIDTH_VAR = "--post-editor-width";

export interface PostSplitResize {
  /** The editor's share of the split, in percent. */
  share: number;
  /** The split's container: a drag measures against it and moves
   *  {@link EDITOR_WIDTH_VAR} on it. */
  containerRef: RefObject<HTMLDivElement | null>;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  reset: () => void;
}

/**
 * The editor/preview split, dragged on the handle between the panes or
 * stepped with the window-splitter keys, and kept per browser.
 *
 * A drag moves the container's CSS variable directly, as the sidebar's does
 * (`hooks/use-sidebar-resize.ts`), so the panes follow the pointer without a
 * render per frame; the release commits the share.
 */
export function usePostSplitResize(): PostSplitResize {
  const [stored, setStored] = useLocalStorage<number>(
    STORAGE_KEY,
    (existing) =>
      typeof existing === "number"
        ? clampEditorShare(existing)
        : POST_EDITOR_SHARE.default,
  );
  const share = clampEditorShare(stored);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const container = containerRef.current;
    const width = container?.getBoundingClientRect().width ?? 0;
    if (!container || width <= 0 || e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    // Tenths of a percent: finer than a pixel, and a tidy stored value.
    const shareAt = (clientX: number) =>
      clampEditorShare(
        Math.round((share + ((clientX - startX) / width) * 100) * 10) / 10,
      );
    let last = share;
    // The site's frame sits beside the handle, and a frame under the pointer
    // takes the moves: without this the drag stops at the preview's edge.
    const frames = Array.from(container.querySelectorAll("iframe"));
    for (const frame of frames) frame.style.pointerEvents = "none";

    const handleMove = (ev: PointerEvent) => {
      last = shareAt(ev.clientX);
      container.style.setProperty(EDITOR_WIDTH_VAR, `${last}%`);
    };
    const handleUp = (ev: PointerEvent) => {
      // A cancel carries no position worth keeping: the last move stands.
      if (ev.type === "pointerup") last = shareAt(ev.clientX);
      container.style.setProperty(EDITOR_WIDTH_VAR, `${last}%`);
      setStored(last);
      for (const frame of frames) frame.style.pointerEvents = "";
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

  // ARIA window-splitter keys: arrows step, Home/End jump to the ends.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const next =
      e.key === "ArrowLeft"
        ? share - KEYBOARD_STEP
        : e.key === "ArrowRight"
          ? share + KEYBOARD_STEP
          : e.key === "Home"
            ? POST_EDITOR_SHARE.min
            : e.key === "End"
              ? POST_EDITOR_SHARE.max
              : null;
    if (next === null) return;
    e.preventDefault();
    setStored(clampEditorShare(next));
  };

  return {
    share,
    containerRef,
    onPointerDown,
    onKeyDown,
    reset: () => setStored(POST_EDITOR_SHARE.default),
  };
}
