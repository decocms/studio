import { useAutoScroll } from "@deco/ui/hooks/use-auto-scroll.ts";

/**
 * Smart auto-scroll sentinel component that handles auto-scrolling when visible.
 * Uses IntersectionObserver to detect when the user has scrolled away, automatically
 * disabling auto-scroll until they scroll back.
 *
 * This component should be rendered at the end of the last message content during streaming.
 */
export function SmartAutoScroll({
  parts,
}: {
  parts: unknown[] | null | undefined;
}) {
  const partsLength = parts?.length;
  const lastPart = parts?.[parts.length - 1];

  const { sentinelRef } = useAutoScroll({
    enabled: true,
    contentDeps: [partsLength, lastPart],
    // Viewport mode: no containerRef, finds scrollable parent automatically
    // threshold 0.1 (default for viewport mode)
  });

  return <div ref={sentinelRef} className="h-0" />;
}
