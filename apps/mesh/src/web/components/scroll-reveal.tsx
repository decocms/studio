import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronDown } from "@untitledui/icons";
import { type ReactNode, useState } from "react";

interface ScrollRevealProps {
  children: ReactNode;
  /** Classes for the scrollable container (e.g. `max-h-[60vh]`). */
  className?: string;
  /** Label for the reveal affordance. */
  label?: string;
}

/**
 * Wraps scrollable content and shows a "Show more" pill whenever the content is
 * not scrolled to the bottom. Without it, an `overflow-y-auto` container silently
 * hides items below the fold — users can't tell there's more to scroll to.
 *
 * Detection is wired through a React 19 callback ref (with cleanup) rather than
 * `useEffect`, which is banned in this codebase.
 */
export function ScrollReveal({
  children,
  className,
  label = "Show more",
}: ScrollRevealProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const containerRef = (node: HTMLDivElement | null) => {
    setContainer(node);
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

  const scrollDown = () => {
    container?.scrollBy({
      top: container.clientHeight * 0.8,
      behavior: "smooth",
    });
  };

  return (
    <div className="relative">
      <div ref={containerRef} className={className}>
        {children}
      </div>
      <div
        aria-hidden={atBottom}
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-2 pt-10",
          "bg-gradient-to-t from-background to-transparent",
          "transition-opacity duration-200",
          atBottom ? "opacity-0" : "opacity-100",
        )}
      >
        <button
          type="button"
          onClick={scrollDown}
          tabIndex={atBottom ? -1 : 0}
          className={cn(
            "flex items-center gap-1 rounded-full border bg-background px-3 py-1",
            "text-xs font-medium text-muted-foreground shadow-sm",
            "transition-colors hover:text-foreground",
            atBottom ? "pointer-events-none" : "pointer-events-auto",
          )}
        >
          {label}
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  );
}
