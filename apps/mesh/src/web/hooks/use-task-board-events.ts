/**
 * useTaskBoardEvents — real-time task board transitions over SSE.
 *
 * Subscribes to the shared `/api/:org/watch` connection, filtered to
 * `task-board.item.updated`, and hands each updated item to `onUpdate`. The
 * Super Agent lifecycle (enqueued→todo, executing→in_progress, PR→in_review)
 * pushes these, so the board moves cards live with no polling.
 *
 * Mirrors `useDecopilotEvents`: useSyncExternalStore for React 19 lifecycle,
 * callbacks read from a ref so the connection stays stable across re-renders.
 */

import type { TaskBoardItem } from "@/storage/types";
import { useRef, useSyncExternalStore } from "react";
import { taskBoardWatchView } from "./watch-sse-pool";

const getSnapshot = () => 0;

export interface UseTaskBoardEventsOptions {
  orgSlug: string;
  enabled?: boolean;
  onUpdate: (item: TaskBoardItem) => void;
}

export function useTaskBoardEvents(options: UseTaskBoardEventsOptions): void {
  const { orgSlug, enabled = true, onUpdate } = options;

  const onUpdateRef = useRef(onUpdate);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept fresh without re-subscribing
  onUpdateRef.current = onUpdate;

  const subscribeRef = useRef<
    ((onStoreChange: () => void) => () => void) | null
  >(null);
  const prevEnabled = useRef(enabled);
  const prevOrgSlug = useRef(orgSlug);

  // Rebuild `subscribe` only when the connection identity (enabled/orgSlug)
  // changes, so the shared EventSource isn't torn down on every re-render.
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
  const needsRebuild =
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    !subscribeRef.current ||
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    prevEnabled.current !== enabled ||
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    prevOrgSlug.current !== orgSlug;

  if (needsRebuild) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    prevEnabled.current = enabled;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    prevOrgSlug.current = orgSlug;

    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    subscribeRef.current = (onStoreChange: () => void) => {
      if (!enabled || !orgSlug) return () => {};

      const handler = (e: MessageEvent) => {
        let event: { data?: TaskBoardItem };
        try {
          event = JSON.parse(e.data) as { data?: TaskBoardItem };
        } catch {
          return;
        }
        if (event.data) onUpdateRef.current(event.data);
        onStoreChange();
      };

      return taskBoardWatchView.subscribe(orgSlug, handler);
    };
  }

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
  useSyncExternalStore(subscribeRef.current!, getSnapshot, getSnapshot);
}
