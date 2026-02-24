import { useRef } from "react";

export function useInfiniteScroll(
  onLoadMore: () => void,
  hasMore: boolean,
  isLoading = false,
): (node: HTMLElement | null) => void {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  const hasMoreRef = useRef(hasMore);
  const isLoadingRef = useRef(isLoading);

  onLoadMoreRef.current = onLoadMore;
  hasMoreRef.current = hasMore;
  isLoadingRef.current = isLoading;

  const lastElementRef = (node: HTMLElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver((entries) => {
      if (
        entries[0]?.isIntersecting &&
        hasMoreRef.current &&
        !isLoadingRef.current
      ) {
        onLoadMoreRef.current();
      }
    });

    if (node) {
      observerRef.current.observe(node);
    }
  };

  return lastElementRef;
}
