/**
 * FLIP animation for the kanban board. When a task changes status its card
 * unmounts from one lane and remounts in another (React re-render), so a CSS
 * transition can't follow it. Instead we measure every card's position before
 * and after the arrangement changes, invert the delta with a transform, then
 * release it — the card slides from its old spot to the new one and the cards
 * it displaces reflow into place. A lane-changing card also leans into its
 * horizontal motion (tilt) and straightens on arrival.
 *
 * Concurrent moves are staggered so cards shift one-after-another instead of a
 * chaotic simultaneous flurry — the "only one at a time" feel without holding
 * back the underlying data (which would risk dropping live SSE updates).
 */

import { useLayoutEffect, useRef } from "react";

const DURATION = 380;
const STAGGER = 90;
const TILT = 5;
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
// A move with meaningful horizontal travel = a lane change (tilt + stagger).
const LANE_CHANGE_DX = 8;

export function useFlipLanes(
  containerRef: React.RefObject<HTMLElement | null>,
  signature: string,
) {
  const prevRects = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const nodes = root.querySelectorAll<HTMLElement>("[data-flip-id]");
    const prev = prevRects.current;
    const next = new Map<string, DOMRect>();

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const moved: { el: HTMLElement; dx: number; dy: number; lane: boolean }[] =
      [];

    for (const el of nodes) {
      const id = el.dataset.flipId;
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      next.set(id, rect);
      const old = prev.get(id);
      if (!old) continue;
      const dx = old.left - rect.left;
      const dy = old.top - rect.top;
      if (dx || dy) {
        moved.push({ el, dx, dy, lane: Math.abs(dx) > LANE_CHANGE_DX });
      }
    }

    prevRects.current = next;
    if (reduced || moved.length === 0) return;

    // Invert: paint every moved card at its previous position (before browser
    // paints the new layout). Lane-changers also start tilted, leaning toward
    // their travel direction, and lift above the others.
    for (const m of moved) {
      const tilt = m.lane ? ` rotate(${m.dx > 0 ? TILT : -TILT}deg)` : "";
      m.el.style.transition = "none";
      m.el.style.transform = `translate(${m.dx}px, ${m.dy}px)${tilt}`;
      if (m.lane) m.el.style.zIndex = "10";
    }

    // Play: release to the new position next frame. Stagger lane-changers so
    // they resolve sequentially.
    let laneOrder = 0;
    const cleanups: number[] = [];
    const raf = requestAnimationFrame(() => {
      for (const m of moved) {
        const delay = m.lane ? laneOrder++ * STAGGER : 0;
        m.el.style.transition = `transform ${DURATION}ms ${EASE} ${delay}ms`;
        m.el.style.transform = "";
        cleanups.push(
          window.setTimeout(
            () => {
              m.el.style.transition = "";
              m.el.style.transform = "";
              m.el.style.zIndex = "";
            },
            DURATION + delay + 30,
          ),
        );
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      for (const t of cleanups) clearTimeout(t);
    };
  }, [signature, containerRef]);
}
