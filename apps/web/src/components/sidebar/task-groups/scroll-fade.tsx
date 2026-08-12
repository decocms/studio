import { useState } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * Wraps a scrollable area and shows a bottom fade when there is more content
 * below the visible viewport. Uses a ref callback for the initial check so no
 * useEffect is needed.
 */
export function ScrollFade({
  className,
  wrapperClassName,
  children,
}: {
  className?: string;
  wrapperClassName?: string;
  children: React.ReactNode;
}) {
  const [hasMore, setHasMore] = useState(false);

  const checkOverflow = (el: HTMLDivElement | null) => {
    if (!el) return;
    setHasMore(el.scrollHeight > el.clientHeight + 1);
  };

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setHasMore(el.scrollHeight - el.scrollTop > el.clientHeight + 1);
  };

  return (
    <div className={cn("relative", wrapperClassName)}>
      <div ref={checkOverflow} onScroll={onScroll} className={className}>
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute right-0 bottom-0 left-0 h-10 bg-gradient-to-t from-sidebar to-transparent transition-opacity duration-150",
          hasMore ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
