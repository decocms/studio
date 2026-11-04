/**
 * Whether a chat of the content track has a run going.
 *
 * A card or a campaign records what its agent was asked to do, not whether it
 * is done: a campaign can be developed and approved while its agent is still
 * writing its last message, and `BLOG_CARD_RUN` refuses the next phase until
 * the chat is free. So this reads the chat itself, follows its status as it is
 * pushed, and counts a start the chat has not picked up yet.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { useDecopilotEvents } from "@/hooks/use-decopilot-events";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool } from "@/lib/studio-tools";
import { useClockTick } from "@/lib/use-clock-tick";
import { useProjectContext } from "@/sdk";

type Chat = NonNullable<
  StudioToolIO["COLLECTION_THREADS_GET"]["output"]["item"]
>;

/** How long a requested start counts as running before the chat takes it: the server's own window. */
const START_WINDOW_MS = 2 * 60_000;

/** A chat running, or a start asked of it after it last moved and not yet taken. */
export function chatRunning(
  chat: Pick<Chat, "status" | "updated_at"> | null | undefined,
  requestedAt: string | undefined,
  now: number,
): boolean {
  if (chat?.status === "in_progress") return true;
  const requested = Date.parse(requestedAt ?? "");
  if (!Number.isFinite(requested) || now - requested >= START_WINDOW_MS) {
    return false;
  }
  const moved = Date.parse(chat?.updated_at ?? "");
  return !(Number.isFinite(moved) && moved >= requested);
}

export function useChatRunning(
  threadId: string | undefined,
  requestedAt: string | undefined,
): boolean {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const now = useClockTick(5_000);
  const queryKey = KEYS.contentTrackChat(org.slug, threadId ?? "");
  const query = useQuery({
    queryKey,
    enabled: !!threadId,
    retry: false,
    queryFn: async () =>
      (
        await callStudioTool(org.slug, "COLLECTION_THREADS_GET", {
          id: threadId ?? "",
        })
      ).item,
  });
  const follow = (status: Chat["status"], time: string) =>
    queryClient.setQueryData<Chat | null>(queryKey, (chat) =>
      chat ? { ...chat, status, updated_at: time } : chat,
    );
  useDecopilotEvents({
    orgSlug: org.slug,
    taskId: threadId,
    enabled: !!threadId,
    onTaskStatus: (event) => follow(event.data.status, event.time),
    onFinish: (event) => follow(event.data.status, event.time),
    // Events missed while the connection was down would leave the chat stuck as running.
    onReconnect: () => void queryClient.invalidateQueries({ queryKey }),
  });
  return chatRunning(query.data, requestedAt, now);
}
