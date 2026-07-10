import { useRef, useState, type PointerEvent } from "react";

/** Shared min / max / default widths for the app's drag-resizable side columns. */
const COLUMN_MIN_WIDTH = 240;
const COLUMN_MAX_WIDTH = 640;
const COLUMN_DEFAULT_WIDTH = 384;

export interface ColumnResize {
  width: number;
  setWidth: (width: number) => void;
  /** Spread onto the drag-divider element. */
  dividerProps: {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
}

/**
 * Pointer-drag width state for a resizable side column. Clamps to [min, max]
 * and self-recovers on pointercancel. Shared by the desktop panel-group column
 * and the preview's inline mobile fallback so the two can't drift.
 */
export function useColumnResize(options?: {
  min?: number;
  max?: number;
  initial?: number;
}): ColumnResize {
  const min = options?.min ?? COLUMN_MIN_WIDTH;
  const max = options?.max ?? COLUMN_MAX_WIDTH;
  const [width, setWidth] = useState(options?.initial ?? COLUMN_DEFAULT_WIDTH);
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const stop = () => {
    resizingRef.current = false;
  };

  return {
    width,
    setWidth,
    dividerProps: {
      onPointerDown: (e) => {
        resizingRef.current = true;
        startXRef.current = e.clientX;
        startWidthRef.current = width;
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e) => {
        if (!resizingRef.current) return;
        const delta = e.clientX - startXRef.current;
        setWidth(Math.max(min, Math.min(max, startWidthRef.current + delta)));
      },
      onPointerUp: stop,
      onPointerCancel: stop,
    },
  };
}
