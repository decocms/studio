import { cn } from "@decocms/ui/lib/utils.ts";
import { type ReactNode, useState } from "react";

interface ScrollRevealProps {
  children: ReactNode;
  /** Classes for the scrollable container (e.g. `max-h-[60vh] overflow-y-auto`). */
  className?: string;
  /**
   * Classes for the outer `relative` wrapper. Use this to let the scroller grow
   * inside a flex column (e.g. `flex min-h-0 flex-1 flex-col`) so the fade can
   * fill available height instead of a fixed `max-h`.
   */
  wrapperClassName?: string;
}

/**
 * Wraps scrollable content and blurs/fades its bottom edge whenever the content
 * is not scrolled all the way down. Without it, an `overflow-y-auto` container
 * silently cuts items off at the fold — users can't tell there's more below.
 *
 * The affordance is purely visual (`pointer-events-none`): the blurred fade
 * hints at more content underneath while scrolling stays on the wheel /
 * trackpad / keyboard as usual.
 *
 * Detection is wired through a React 19 callback ref (with cleanup) rather than
 * `useEffect`, which is banned in this codebase.
 */
export function ScrollReveal({
  children,
  className,
  wrapperClassName,
}: ScrollRevealProps) {
  const [atBottom, setAtBottom] = useState(true);

  const containerRef = (node: HTMLDivElement | null) => {
    if (!node) {
      return;
    }

    const measure = () => {
      const reachedBottom =
        node.scrollHeight - node.scrollTop - node.clientHeight < 8;
      setAtBottom(reachedBottom);
    };

    measure();
    node.addEventListener("scroll", measure, { passive: true });
    // Re-measure when the container or its content changes size.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of Array.from(node.children)) {
      observer.observe(child);
    }

    return () => {
      node.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  };

  return (
    <div className={cn("relative", wrapperClassName)}>
      <div ref={containerRef} className={className}>
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          // `-bottom-px` (not `bottom-0`) so the fade over-covers the scroller's
          // sub-pixel clip edge instead of stopping a fraction of a pixel short.
          "pointer-events-none absolute inset-x-0 -bottom-px h-[72px]",
          // Fade to the sidebar surface these scrollers sit on (AuthSplitLayout)
          // so the solid end blends into the panel instead of showing a lighter
          // `background` band.
          //
          // The `6px` first stop on BOTH the color gradient and the mask is the
          // fix for the hairline leak: a CSS gradient holds its first stop's
          // value for everything before it, so `… 6px, transparent` is fully
          // opaque from 0–6px, then ramps. Without the plateau the ramp only
          // reaches 100% at the very bottom edge, leaving the scroller's clip
          // line (~1px above it) at ~99% coverage — enough for the hard cut edge
          // of the last card to bleed through as a 1px sliver at any DPR. The
          // plateau guarantees the clip line sits inside the solid zone.
          "bg-gradient-to-t from-sidebar from-[6px] to-transparent",
          "backdrop-blur-[1px] [mask-image:linear-gradient(to_top,black_6px,transparent)]",
          "transition-opacity duration-200",
          atBottom ? "opacity-0" : "opacity-100",
        )}
      />
    </div>
  );
}
