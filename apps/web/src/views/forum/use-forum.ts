/** Forum data: channels, topics and one topic with its replies. Topics are
 *  task cards, so a reply is posted with `TASK_BOARD_COMMENT_CREATE`. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

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

export function useForumTopic(keySeq: number) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.forumTopic(locator, keySeq),
    queryFn: () => studio.call("FORUM_TOPIC_GET", { keySeq }),
  });
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
      projectId: string;
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

  return { createTopic, vote, reply, removeReply };
}
