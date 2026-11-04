/**
 * The content track's blogpost cards: read once, then kept live.
 *
 * Every card write is pushed as `blog.card.updated`, by a person or by the
 * card's agent, and lands in the cache as it comes. Two safety nets cover a
 * missed push: one re-read when a card's chat finishes, and a 15-second poll
 * only while some card's agent is at work.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BlogCard } from "@decocms/shared/blog-card";
import type { StudioToolInput } from "@decocms/shared/tools/tool-io";
import { useBlogCardEvents } from "@/hooks/use-blog-card-events";
import { useDecopilotEvents } from "@/hooks/use-decopilot-events";
import {
  cardAgentWorking,
  upsertCard,
} from "@/layouts/content-track/card-model";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

const POLL_WHILE_WORKING_MS = 15_000;

export function useBlogCards() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.blogCards(org.slug);

  const query = useQuery({
    queryKey,
    queryFn: async () => (await studio.call("BLOG_CARD_LIST", {})).cards,
    refetchInterval: (current) =>
      (current.state.data ?? []).some((card) =>
        cardAgentWorking(card, Date.now()),
      )
        ? POLL_WHILE_WORKING_MS
        : false,
  });
  const cards = query.data ?? [];

  const store = (card: BlogCard) => {
    // A list read issued before this write would land after it and undo it.
    void queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<BlogCard[]>(queryKey, (prev) =>
      upsertCard(prev ?? [], card),
    );
  };
  const reread = () => void queryClient.invalidateQueries({ queryKey });

  useBlogCardEvents({
    orgSlug: org.slug,
    onUpdate: store,
    onDelete: (id) => {
      void queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<BlogCard[]>(queryKey, (prev) =>
        (prev ?? []).filter((card) => card.id !== id),
      );
    },
    onResync: reread,
  });

  useDecopilotEvents({
    orgSlug: org.slug,
    onTaskStatus: (event) => {
      if (event.data.status === "in_progress") return;
      const current = queryClient.getQueryData<BlogCard[]>(queryKey) ?? [];
      if (current.some((card) => card.threadId === event.subject)) reread();
    },
  });

  const create = useMutation({
    mutationFn: (input: StudioToolInput<"BLOG_CARD_CREATE">) =>
      studio.call("BLOG_CARD_CREATE", input),
    onSuccess: ({ card }) => store(card),
  });
  const update = useMutation({
    mutationFn: (input: StudioToolInput<"BLOG_CARD_UPDATE">) =>
      studio.call("BLOG_CARD_UPDATE", input),
    onSuccess: ({ card }) => store(card),
    onError: reread,
  });
  const run = useMutation({
    mutationFn: (input: StudioToolInput<"BLOG_CARD_RUN">) =>
      studio.call("BLOG_CARD_RUN", input),
    onSuccess: ({ card }) => store(card),
    onError: reread,
  });
  const remove = useMutation({
    mutationFn: (id: string) => studio.call("BLOG_CARD_DELETE", { id }),
    onSuccess: ({ id }) =>
      queryClient.setQueryData<BlogCard[]>(queryKey, (prev) =>
        (prev ?? []).filter((card) => card.id !== id),
      ),
  });

  return {
    cards,
    isLoading: query.isLoading,
    create,
    update,
    run,
    remove,
  };
}
