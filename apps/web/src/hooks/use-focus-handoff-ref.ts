import { type RefCallback, type RefObject, useState } from "react";

export const FOCUSABLE_HANDOFF_TARGET = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

interface FocusHandoffTarget {
  ref: RefObject<HTMLElement | null>;
  selector?: string;
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.getClientRects().length === 0) {
    return false;
  }
  if (element.closest('[inert], [aria-hidden="true"]')) return false;

  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function hasUsableFocus(document: Document): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active !== document.body &&
    isVisible(active)
  );
}

function resolveTarget(
  root: HTMLElement | null,
  selector?: string,
): HTMLElement | null {
  if (!root) return null;
  if (!selector) return isVisible(root) ? root : null;

  for (const candidate of root.querySelectorAll<HTMLElement>(selector)) {
    if (isVisible(candidate)) return candidate;
  }
  return null;
}

/**
 * Merges an object ref with a stable React 19 callback ref that preserves a
 * meaningful focus position when the source is removed. This is particularly
 * useful for responsive controls: their cleanup runs before the compact-only
 * node disappears, while it can still prove that it owned focus.
 *
 * Target refs and selectors are intentionally captured once. Pass stable
 * `useRef` objects and static selectors, in preferred fallback order.
 */
export function useFocusHandoffRef<T extends HTMLElement>(
  sourceRef: RefObject<T | null>,
  ...targets: FocusHandoffTarget[]
): RefCallback<T> {
  const [callbackRef] = useState<RefCallback<T>>(() => (node: T | null) => {
    if (!node) {
      sourceRef.current = null;
      return;
    }

    sourceRef.current = node;
    return () => {
      if (sourceRef.current === node) sourceRef.current = null;

      const document = node.ownerDocument;
      const active = document.activeElement;
      if (active !== node && !node.contains(active)) return;

      document.defaultView?.requestAnimationFrame(() => {
        // Explicit dialog, pane, or route handoffs win if they already moved
        // focus before this responsive cleanup runs.
        if (hasUsableFocus(document)) return;

        for (const target of targets) {
          const element = resolveTarget(target.ref.current, target.selector);
          if (!element) continue;
          element.focus({ preventScroll: true });
          if (document.activeElement === element) return;
        }
      });
    };
  });

  return callbackRef;
}
