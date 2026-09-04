import { useElementSize } from "./use-element-size";

/**
 * Measures an element's content-box width and keeps it live via a
 * `ResizeObserver`. Wired through a React 19 callback ref (with cleanup)
 * instead of `useEffect`, which is banned in this codebase.
 *
 * Returns `[width, ref]`; attach `ref` to the element to measure. `width` is
 * `-1` (NOT `0`) until the first measurement lands — a real element can legitimately
 * measure `0` (e.g. a flex gap that has collapsed), and callers must be able to tell
 * "no space" apart from "not measured yet". Guard breakpoints with `width < 0`.
 */
export function useElementWidth(): readonly [
  number,
  (node: HTMLElement | null) => void | (() => void),
] {
  const [{ width }, ref] = useElementSize();
  return [width, ref] as const;
}
