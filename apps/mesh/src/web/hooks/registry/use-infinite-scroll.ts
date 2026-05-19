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

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  onLoadMoreRef.current = onLoadMore;
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  hasMoreRef.current = hasMore;
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
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
