/**
 * FLIP animation for lane changes that don't go through an active drag — the
 * agent auto-moving a card, or the bulk "Move to" action. Those just patch
 * `items` and let React reconcile: the card unmounts from one lane's
 * `SortableContext` and remounts in another with no transition to follow.
 * Dragging already gets its own smooth motion from dnd-kit (live gap preview
 * + the `landed` settle animation), so this hook stays out of its way while
 * `enabled` is false and only measures/animates when it's true.
 *
 * Concurrent moves are staggered so cards shift one-after-another instead of a
 * chaotic simultaneous flurry — the "only one at a time" feel without holding
 * back the underlying data (which would risk dropping live SSE updates).
 */

import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

const DURATION = 380;
const STAGGER = 90;
const TILT = 5;
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";

export function useFlipLanes(
  containerRef: RefObject<HTMLElement | null>,
  signature: string,
  enabled: boolean,
) {
  // Remember each card's position AND which lane it was in, so a lane change is
  // detected by the column it actually moved between — not by horizontal delta,
  // which a board-wide sideways shift (scrollbar toggling, row re-centering)
  // gives to every card at once, tilting the whole board.
  const prev = useRef<Map<string, { rect: DOMRect; lane?: string }>>(new Map());
  // Ref-counted per lane so two cards animating through the same column at
  // once don't have the first one's cleanup re-clip it while the second is
  // still mid-flight.
  const unclipped = useRef<Map<HTMLElement, number>>(new Map());

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const nodes = root.querySelectorAll<HTMLElement>("[data-flip-id]");
    const next = new Map<string, { rect: DOMRect; lane?: string }>();
    const prevPositions = prev.current;
    // Always resync — even while `enabled` is false — so a drag's continuous
    // position changes (live gap preview) are the baseline once it ends, and
    // the settle isn't misread as a full-distance move needing its own FLIP.
    prev.current = next;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const moved: { el: HTMLElement; dx: number; dy: number; lane: boolean }[] =
      [];

    for (const el of nodes) {
      const id = el.dataset.flipId;
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      const lane = el.dataset.flipLane;
      next.set(id, { rect, lane });
      if (!enabled) continue;
      const old = prevPositions.get(id);
      if (!old) continue;
      const dx = old.rect.left - rect.left;
      const dy = old.rect.top - rect.top;
      if (dx || dy) {
        moved.push({ el, dx, dy, lane: old.lane !== lane });
      }
    }

    if (!enabled || reduced || moved.length === 0) return;

    // A lane-changer travels sideways out of its own column for the length of
    // the animation — its home lane clips that (an `overflow-y` container's
    // `overflow-x` computes to `auto`, never `visible`, so it always clips).
    // Lift the clip on that lane for the duration and restore it afterward.
    const counts = unclipped.current;
    const unclip = (laneEl: Element | null) => {
      if (!(laneEl instanceof HTMLElement)) return;
      counts.set(laneEl, (counts.get(laneEl) ?? 0) + 1);
      laneEl.style.overflow = "visible";
    };
    const reclip = (laneEl: Element | null) => {
      if (!(laneEl instanceof HTMLElement)) return;
      const count = (counts.get(laneEl) ?? 1) - 1;
      if (count > 0) {
        counts.set(laneEl, count);
        return;
      }
      counts.delete(laneEl);
      laneEl.style.overflow = "";
    };

    // Invert: paint every moved card at its previous position (before browser
    // paints the new layout). Lane-changers also start tilted, leaning toward
    // their travel direction, and lift above the others.
    for (const m of moved) {
      const tilt = m.lane ? ` rotate(${m.dx > 0 ? TILT : -TILT}deg)` : "";
      m.el.style.transition = "none";
      m.el.style.transform = `translate(${m.dx}px, ${m.dy}px)${tilt}`;
      if (m.lane) {
        m.el.style.zIndex = "10";
        unclip(m.el.closest("[data-lane-scroll]"));
      }
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
              if (m.lane) reclip(m.el.closest("[data-lane-scroll]"));
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
  }, [signature, containerRef, enabled]);
}
