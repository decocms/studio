/** Forum data: channels, topics and one topic with its replies. Topics are
 *  task cards, so a reply is posted with `TASK_BOARD_COMMENT_CREATE`. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

export type ForumChannel =
  StudioToolOutput<"FORUM_CHANNEL_LIST">["channels"][number];
export type ForumTopic = StudioToolOutput<"FORUM_TOPIC_LIST">["topics"][number];
export type ForumReply = StudioToolOutput<"FORUM_TOPIC_GET">["replies"][number];

export function useForumChannels() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.forumChannels(locator),
    queryFn: async () => (await studio.call("FORUM_CHANNEL_LIST", {})).channels,
  });
}

/** Every topic in the org's channels, or only one project's. */
export function useForumTopics(channelId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.forumChannelTopics(locator, channelId ?? "all"),
    queryFn: async () =>
      (await studio.call("FORUM_TOPIC_LIST", { channelId })).topics,
  });
}

/** `awaitingAgent` polls while deco is still writing its answer (a `/score`
 *  scan takes minutes); everything else arrives through the topic list. */
export function useForumTopic(keySeq: number) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.forumTopic(locator, keySeq),
    queryFn: () => studio.call("FORUM_TOPIC_GET", { keySeq }),
    refetchInterval: (query) =>
      query.state.data && awaitingAgent(query.state.data) ? 10_000 : false,
  });
}

/** A `/score` topic deco has not answered yet. */
export function awaitingAgent(data: {
  topic: ForumTopic;
  replies: ForumReply[];
}): boolean {
  return (
    data.topic.tags.some((tag) => tag.name === "Score") &&
    !data.replies.some((reply) => reply.author.id === SUPER_AGENT_ASSIGNEE_ID)
  );
}

/** Every forum read shares the `forum-topics` prefix, plus the channel counts. */
function useInvalidateForum() {
  const { locator } = useProjectContext();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: KEYS.forumTopics(locator) });
    void queryClient.invalidateQueries({
      queryKey: KEYS.forumChannels(locator),
    });
    void queryClient.invalidateQueries({
      queryKey: KEYS.taskBoardItems(locator),
    });
  };
}

export function useForumMutations() {
  const studio = useStudioTools();
  const invalidate = useInvalidateForum();

  const createTopic = useMutation({
    mutationFn: (input: {
      virtualMcpId: string;
      title: string;
      description: string;
      tagIds: string[];
    }) => studio.call("TASK_BOARD_ITEM_CREATE", input),
    onSuccess: invalidate,
  });

  const vote = useMutation({
    mutationFn: (topicId: string) =>
      studio.call("FORUM_TOPIC_VOTE", { topicId }),
    onSuccess: invalidate,
  });

  const reply = useMutation({
    mutationFn: (input: { topicId: string; body: string }) =>
      studio.call("TASK_BOARD_COMMENT_CREATE", {
        taskBoardItemId: input.topicId,
        body: input.body,
      }),
    onSuccess: invalidate,
  });

  const removeReply = useMutation({
    mutationFn: (id: string) =>
      studio.call("TASK_BOARD_COMMENT_DELETE", { id }),
    onSuccess: invalidate,
  });

  const editReply = useMutation({
    mutationFn: (input: { id: string; body: string }) =>
      studio.call("TASK_BOARD_COMMENT_UPDATE", input),
    onSuccess: invalidate,
  });

  const score = useMutation({
    mutationFn: (input: { topicId: string; domain: string }) =>
      studio.call("FORUM_TOPIC_SCORE", input),
  });

  return { createTopic, vote, reply, removeReply, editReply, score };
}
