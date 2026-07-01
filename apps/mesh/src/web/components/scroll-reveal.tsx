import { cn } from "@deco/ui/lib/utils.ts";
import { type ReactNode, useState } from "react";

interface ScrollRevealProps {
  children: ReactNode;
  /** Classes for the scrollable container (e.g. `max-h-[60vh] overflow-y-auto`). */
  className?: string;
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
export function ScrollReveal({ children, className }: ScrollRevealProps) {
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
    <div className="relative">
      <div ref={containerRef} className={className}>
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-[213px]",
          "bg-gradient-to-t from-background to-transparent",
          "backdrop-blur-[2px] [mask-image:linear-gradient(to_top,black,transparent)]",
          "transition-opacity duration-200",
          atBottom ? "opacity-0" : "opacity-100",
        )}
      />
    </div>
  );
}
