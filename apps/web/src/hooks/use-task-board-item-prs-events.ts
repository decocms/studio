/**
 * useTaskBoardItemPrsEvents — live PR cards for one open task dialog.
 *
 * Subscribes to the shared `/api/:org/watch` connection, filtered to
 * `task-board.item.prs.updated`, and hands the fresh cards for THIS task to
 * `onPrs`. The GitHub webhook pushes that event when CI finishes or a deploy
 * bot posts a preview url, so the dialog's checks and Preview button update
 * without waiting for its poll.
 *
 * Mirrors `useTaskBoardEvents`: useSyncExternalStore for React 19 lifecycle,
 * callback read from a ref so the connection stays stable across re-renders.
 */

import type { TaskBoardItemPr } from "@/layouts/task-board/config";
import { useRef, useSyncExternalStore } from "react";
import { taskBoardPrsWatchView } from "./watch-sse-pool";

const getSnapshot = () => 0;

export function useTaskBoardItemPrsEvents(options: {
  orgSlug: string;
  itemId: string | undefined;
  onPrs: (prs: TaskBoardItemPr[]) => void;
}): void {
  const { orgSlug, itemId, onPrs } = options;

  const onPrsRef = useRef(onPrs);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept fresh without re-subscribing
  onPrsRef.current = onPrs;

  const subscribeRef = useRef<
    ((onStoreChange: () => void) => () => void) | null
  >(null);
  const prevKey = useRef<string>("");
  const key = `${orgSlug}:${itemId ?? ""}`;

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
  if (!subscribeRef.current || prevKey.current !== key) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    prevKey.current = key;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    subscribeRef.current = (onStoreChange: () => void) => {
      if (!orgSlug || !itemId) return () => {};
      const handler = (e: MessageEvent) => {
        let event: { data?: { id?: string; prs?: TaskBoardItemPr[] } };
        try {
          event = JSON.parse(e.data);
        } catch {
          return;
        }
        // Org-wide stream: every open dialog sees every task's push.
        if (event.data?.id !== itemId || !Array.isArray(event.data.prs)) return;
        onPrsRef.current(event.data.prs);
        onStoreChange();
      };
      return taskBoardPrsWatchView.subscribe(orgSlug, handler);
    };
  }

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
  useSyncExternalStore(subscribeRef.current!, getSnapshot, getSnapshot);
}
