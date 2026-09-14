import { useState } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

type ElementSizeRef = (node: HTMLElement | null) => void | (() => void);

const UNMEASURED_SIZE: ElementSize = { width: -1, height: -1 };

/**
 * Observes an element's content box without introducing an effect-owned
 * subscription. React 19 callback-ref cleanup disconnects the observer at the
 * same commit boundary that removes or replaces the element.
 */
export function useElementSize(): readonly [ElementSize, ElementSizeRef] {
  const [size, setSize] = useState<ElementSize>(UNMEASURED_SIZE);
  const [ref] = useState<ElementSizeRef>(() => (node: HTMLElement | null) => {
    if (!node) return;
    const measure = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      setSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  });

  return [size, ref] as const;
}
