/**
 * useTaskBoardEvents — real-time task board transitions over SSE.
 *
 * Subscribes to the shared `/api/:org/watch` connection, filtered to
 * `task-board.item.updated` / `.deleted`, and hands each updated item to
 * `onUpdate` and each removed id to `onDelete`. Creates, Super Agent
 * transitions (enqueued→todo, executing→in_progress, PR→in_review) and deletes
 * push these, so the board adds/moves/removes cards live with no polling.
 *
 * Mirrors `useDecopilotEvents`: useSyncExternalStore for React 19 lifecycle,
 * callbacks read from a ref so the connection stays stable across re-renders.
 */

import type { TaskBoardItem } from "@/storage/types";
import { TASK_BOARD_ITEM_DELETED_EVENT } from "@/shared/task-board";
import { useRef, useSyncExternalStore } from "react";
import { taskBoardWatchView } from "./watch-sse-pool";

const getSnapshot = () => 0;

export interface UseTaskBoardEventsOptions {
  orgSlug: string;
  enabled?: boolean;
  onUpdate: (item: TaskBoardItem) => void;
  onDelete?: (id: string) => void;
}

export function useTaskBoardEvents(options: UseTaskBoardEventsOptions): void {
  const { orgSlug, enabled = true, onUpdate, onDelete } = options;

  const onUpdateRef = useRef(onUpdate);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept fresh without re-subscribing
  onUpdateRef.current = onUpdate;

  const onDeleteRef = useRef(onDelete);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept fresh without re-subscribing
  onDeleteRef.current = onDelete;

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
        let event: { data?: TaskBoardItem | { id: string } };
        try {
          event = JSON.parse(e.data) as {
            data?: TaskBoardItem | { id: string };
          };
        } catch {
          return;
        }
        if (event.data) {
          if (e.type === TASK_BOARD_ITEM_DELETED_EVENT) {
            onDeleteRef.current?.((event.data as { id: string }).id);
          } else {
            onUpdateRef.current(event.data as TaskBoardItem);
          }
        }
        onStoreChange();
      };

      return taskBoardWatchView.subscribe(orgSlug, handler);
    };
  }

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
  useSyncExternalStore(subscribeRef.current!, getSnapshot, getSnapshot);
}
