/**
 * useBlogCardEvents — the content track's cards, live, over SSE.
 *
 * Subscribes to the shared `/api/:org/watch` connection, filtered to
 * `blog.card.updated` / `.deleted`. Every card write pushes one, whether a
 * person or the card's agent made it, so the board and an open card follow
 * the agent's work without polling. The payload is validated before it is
 * handed on: it is the stored card, and a card is a file anyone can write.
 *
 * Mirrors `useTaskBoardEvents`.
 */

import {
  BLOG_CARD_DELETED_EVENT,
  type BlogCard,
  BlogCardSchema,
} from "@decocms/shared/blog-card";
import { useRef, useSyncExternalStore } from "react";
import { blogCardWatchView } from "./watch-sse-pool";

const getSnapshot = () => 0;

export interface UseBlogCardEventsOptions {
  orgSlug: string;
  enabled?: boolean;
  onUpdate: (card: BlogCard) => void;
  onDelete: (id: string) => void;
  /** Called after each stream re-establishment — refetch to close the gap. */
  onResync?: () => void;
}

export function useBlogCardEvents(options: UseBlogCardEventsOptions): void {
  const { orgSlug, enabled = true, onUpdate, onDelete, onResync } = options;

  const onUpdateRef = useRef(onUpdate);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept fresh without re-subscribing
  onUpdateRef.current = onUpdate;

  const onDeleteRef = useRef(onDelete);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept fresh without re-subscribing
  onDeleteRef.current = onDelete;

  const onResyncRef = useRef(onResync);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- callback kept fresh without re-subscribing
  onResyncRef.current = onResync;

  const subscribeRef = useRef<
    ((onStoreChange: () => void) => () => void) | null
  >(null);
  const prevEnabled = useRef(enabled);
  const prevOrgSlug = useRef(orgSlug);

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
        let data: unknown;
        try {
          data = (JSON.parse(e.data) as { data?: unknown }).data;
        } catch {
          return;
        }
        if (e.type === BLOG_CARD_DELETED_EVENT) {
          const id = (data as { id?: unknown } | undefined)?.id;
          if (typeof id === "string") onDeleteRef.current(id);
        } else {
          const card = BlogCardSchema.safeParse(data);
          if (card.success) onUpdateRef.current(card.data);
        }
        onStoreChange();
      };

      return blogCardWatchView.subscribe(orgSlug, handler, () =>
        onResyncRef.current?.(),
      );
    };
  }

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
  useSyncExternalStore(subscribeRef.current!, getSnapshot, getSnapshot);
}
