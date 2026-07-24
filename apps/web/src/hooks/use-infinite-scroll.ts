import { useRef, useState } from "react";

/**
 * Hook for infinite scroll functionality using IntersectionObserver.
 *
 * @param onLoadMore - Callback function to load more items
 * @param hasMore - Whether there are more items to load
 * @param isLoading - Whether data is currently loading (prevents duplicate triggers)
 * @param rootRef - Optional ref to the scroll container. When omitted the
 *                  observer falls back to the viewport, which fires based on
 *                  page-level visibility rather than visibility *inside the
 *                  scroll container*. Pass the scrollable parent ref to
 *                  avoid cascade-loading short lists that already fit on
 *                  screen.
 * @returns A stable ref callback to attach to a dedicated sentinel element
 *          rendered AFTER the last item. Attaching it to the last row works
 *          but is fragile under client-side filtering — the row identity
 *          shifts every time a page loads, which re-fires the observer.
 *
 * @example
 * ```tsx
 * const sentinelRef = useInfiniteScroll(
 *   () => fetchNextPage(),
 *   hasNextPage,
 *   isFetchingNextPage,
 *   scrollContainerRef,
 * );
 *
 * return (
 *   <div ref={scrollContainerRef} className="overflow-y-auto">
 *     {items.map((item) => <Row key={item.id} item={item} />)}
 *     <div ref={sentinelRef} aria-hidden />
 *   </div>
 * );
 * ```
 */
export function useInfiniteScroll(
  onLoadMore: () => void,
  hasMore: boolean,
  isLoading = false,
  rootRef?: React.RefObject<HTMLElement | null>,
): (node: HTMLElement | null) => void {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const desiredNodeRef = useRef<HTMLElement | null>(null);

  // Refs mirror the latest values so the (stable) ref callback closes over
  // refs only and the observer callback always sees fresh state.
  const onLoadMoreRef = useRef(onLoadMore);
  const hasMoreRef = useRef(hasMore);
  const isLoadingRef = useRef(isLoading);
  const rootRefRef = useRef(rootRef);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  onLoadMoreRef.current = onLoadMore;
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  hasMoreRef.current = hasMore;
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  isLoadingRef.current = isLoading;
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  rootRefRef.current = rootRef;

  // Stable ref callback. Built once via useState's lazy initializer so React
  // doesn't detach + reattach on every parent render — the previous
  // "function literal per render" pattern made the observer re-fire while a
  // page was loading.
  const [stableRef] = useState<(node: HTMLElement | null) => void>(() => {
    return (node: HTMLElement | null) => {
      desiredNodeRef.current = node;

      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (!node) return;

      // Defer observer creation to a microtask so the scroll container's ref
      // (set during the same commit but after this child ref) is populated
      // by the time we read it. Without this, the first observer on initial
      // mount uses `root: null` (the viewport) instead of the container.
      queueMicrotask(() => {
        if (desiredNodeRef.current !== node) return;

        const observer = new IntersectionObserver(
          (entries) => {
            if (
              entries[0]?.isIntersecting &&
              hasMoreRef.current &&
              !isLoadingRef.current
            ) {
              onLoadMoreRef.current();
            }
          },
          {
            root: rootRefRef.current?.current ?? null,
            rootMargin: "0px 0px 200px 0px",
          },
        );
        observer.observe(node);
        observerRef.current = observer;
      });
    };
  });

  return stableRef;
}
