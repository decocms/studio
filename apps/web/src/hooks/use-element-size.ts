import { useState } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Measures an element's content-box size and keeps it live via a
 * `ResizeObserver` on a React 19 callback ref — the two-axis sibling of
 * `useElementWidth`. Both axes are `-1` until the first measurement lands.
 */
export function useElementSize(): readonly [
  ElementSize,
  (node: HTMLElement | null) => void | (() => void),
] {
  const [size, setSize] = useState<ElementSize>({ width: -1, height: -1 });

  const ref = (node: HTMLElement | null) => {
    if (!node) return;
    const measure = () =>
      setSize((prev) =>
        prev.width === node.clientWidth && prev.height === node.clientHeight
          ? prev
          : { width: node.clientWidth, height: node.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  };

  return [size, ref] as const;
}
