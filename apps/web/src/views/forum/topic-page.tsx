/** One forum topic: the original post, then replies (card comments, one level
 *  of nesting), then the composer. */

import { ArrowLeft } from "@untitledui/icons";
import { toast } from "sonner";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { MemoizedMarkdown } from "@/components/chat/markdown";
import { authClient } from "@/lib/auth-client";
import { getInitials } from "@/lib/get-initials";
import { formatTimeAgo } from "@/lib/format-time";
import { useT } from "@/i18n/use-t.ts";
import {
  CommentThreadCard,
  NewCommentComposer,
  type CommentAuthor,
  type TaskComment,
} from "@/layouts/task-board/task-comments";
import { KindBadge, StatusPill, VoteButton } from "./forum-parts";
import { useForumMutations, useForumTopic, type ForumReply } from "./use-forum";

/** Replies come back flat; a reply's parent is always a root. */
function toThreads(replies: ForumReply[]): TaskComment[] {
  const toComment = (reply: ForumReply): TaskComment => ({
    id: reply.id,
    author: {
      id: reply.author.id,
      name: reply.author.name,
      image: reply.author.image,
    },
    body: reply.body,
    createdAt: reply.createdAt,
    replies: [],
  });
  const roots = replies.filter((r) => !r.parentId).map(toComment);
  const byId = new Map(roots.map((root) => [root.id, root]));
  for (const reply of replies) {
    if (reply.parentId)
      byId.get(reply.parentId)?.replies.push(toComment(reply));
  }
  return roots;
}

/** Shown by the board's Threads view in place of the card detail. */
export function TopicPage({
  keySeq,
  onBack,
}: {
  keySeq: number;
  onBack: () => void;
}) {
  const t = useT();
  const { data: session } = authClient.useSession();
  const { data, isPending, error } = useForumTopic(keySeq);
  const { reply, removeReply } = useForumMutations();

  const back = (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft size={14} />
      {t("forum.backToThreads")}
    </button>
  );

  if (isPending || error || !data) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
        {back}
        <p className="text-sm text-muted-foreground">
          {error ? t("forum.topicNotFound") : t("forum.loading")}
        </p>
      </div>
    );
  }

  const { topic } = data;
  const threads = toThreads(data.replies);
  const me: CommentAuthor = {
    id: session?.user.id ?? "",
    name: session?.user.name ?? "",
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
        {back}
        <article className="flex gap-4">
          <VoteButton topic={topic} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {topic.tags.map((tag) => (
                <KindBadge key={tag.id} tag={tag} />
              ))}
              <StatusPill status={topic.status} />
            </div>
            <h1 className="text-xl font-semibold leading-tight text-foreground">
              {topic.title}
            </h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Avatar
                url={topic.author.image ?? undefined}
                fallback={getInitials(topic.author.name)}
                shape="circle"
                size="xs"
              />
              <span className="text-foreground">{topic.author.name}</span>
              <span aria-hidden>·</span>
              <time dateTime={topic.createdAt}>
                {formatTimeAgo(new Date(topic.createdAt))}
              </time>
            </div>
            {topic.body && (
              <div className="text-[15px] leading-relaxed text-foreground">
                <MemoizedMarkdown id={topic.id} text={topic.body} />
              </div>
            )}
          </div>
        </article>

        <section className="flex flex-col gap-4 border-t border-border pt-6">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("forum.replies", { count: data.replies.length })}
          </h2>
          {threads.map((thread) => (
            <CommentThreadCard
              key={thread.id}
              thread={thread}
              me={me}
              onDelete={(id) => removeReply.mutate(id)}
            />
          ))}
          <NewCommentComposer
            onSubmit={async (body) => {
              try {
                await reply.mutateAsync({ topicId: topic.id, body });
                return true;
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : t("forum.replyFailed"),
                );
                return false;
              }
            }}
          />
        </section>
      </div>
    </div>
  );
}
