/**
 * The board's Threads view: the same cards as Board / List / Feed, read as a
 * forum. Ranked by Hot / New / Top / Unanswered, narrowed by kind. On the
 * org-wide board it spans every forum channel and names each row's channel.
 */

import { useState } from "react";
import { MessageSquare01, Plus } from "@untitledui/icons";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { getInitials } from "@/lib/get-initials";
import { formatTimeAgo } from "@/lib/format-time";
import { useT } from "@/i18n/use-t.ts";
import { KindBadge, StatusPill, VoteButton } from "./forum-parts";
import { NewTopicDialog } from "./new-topic-dialog";
import { sortTopics, type ForumSort } from "./ranking";
import {
  useForumChannels,
  useForumTopics,
  type ForumChannel,
  type ForumTopic,
} from "./use-forum";

const SORTS: ForumSort[] = ["hot", "new", "top", "unanswered"];

type TopicAddress = { id: string; keySeq: number | null };

export function ThreadsView({
  project,
  onOpen,
}: {
  /** The channel; absent on the org-wide board. */
  project?: VirtualMCPEntity;
  onOpen: (topic: TopicAddress) => void;
}) {
  const t = useT();
  const channels = useForumChannels();
  const topics = useForumTopics(project?.id);
  const [sort, setSort] = useState<ForumSort>("hot");
  const [kind, setKind] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  // Ranking reference time, fixed per visit so rows don't reshuffle on render.
  const [now] = useState(() => Date.now());

  const kinds = project?.metadata?.forum?.kinds ?? [];
  const visible = sortTopics(
    (topics.data ?? []).filter(
      (topic) => !kind || topic.tags.some((tag) => tag.name === kind),
    ),
    sort,
    now,
  );
  const channelById = new Map((channels.data ?? []).map((c) => [c.id, c]));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-4 pb-10 md:px-8">
      <div className="flex flex-wrap items-center gap-1.5">
        {SORTS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setSort(value)}
            className={cn(
              "h-7 cursor-pointer rounded-lg px-2.5 text-sm transition-colors",
              sort === value
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`forum.sort.${value}`)}
          </button>
        ))}
        {kinds.length > 1 && (
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        )}
        {kinds.length > 1 &&
          kinds.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setKind(kind === name ? null : name)}
              className={cn(
                "h-7 cursor-pointer rounded-full border px-2.5 text-xs transition-colors",
                kind === name
                  ? "border-foreground/40 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {name}
            </button>
          ))}
        {project && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto gap-1.5"
            onClick={() => setComposing(true)}
          >
            <Plus size={14} />
            {t("forum.newTopic")}
          </Button>
        )}
      </div>

      <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border bg-card">
        {topics.isPending && (
          <li className="p-6 text-sm text-muted-foreground">
            {t("forum.loading")}
          </li>
        )}
        {!topics.isPending && visible.length === 0 && (
          <li className="p-6 text-sm text-muted-foreground">
            {sort === "unanswered"
              ? t("forum.emptyUnanswered")
              : t("forum.empty")}
          </li>
        )}
        {visible.map((topic) => (
          <TopicRow
            key={topic.id}
            topic={topic}
            channel={project ? undefined : channelById.get(topic.channelId)}
            onOpen={() => onOpen(topic)}
          />
        ))}
      </ul>

      {composing && project && (
        <NewTopicDialog
          project={project}
          onClose={() => setComposing(false)}
          onCreated={onOpen}
        />
      )}
    </div>
  );
}

function TopicRow({
  topic,
  channel,
  onOpen,
}: {
  topic: ForumTopic;
  /** Named on the row only when the list spans channels. */
  channel?: ForumChannel;
  onOpen: () => void;
}) {
  const t = useT();
  const excerpt = (topic.body ?? "")
    .replace(/[#*_`>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return (
    <li className="flex gap-3 p-4 transition-colors hover:bg-muted/40">
      <VoteButton topic={topic} />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer gap-3 text-left"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {topic.tags.map((tag) => (
              <KindBadge key={tag.id} tag={tag} />
            ))}
            <StatusPill status={topic.status} />
            {channel && (
              <span className="text-xs text-muted-foreground">
                # {channel.title}
              </span>
            )}
          </div>
          <span className="text-[15px] font-medium leading-snug text-foreground">
            {topic.title}
          </span>
          {excerpt && (
            <span className="line-clamp-1 text-sm text-muted-foreground">
              {excerpt}
            </span>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Avatar
              url={topic.author.image ?? undefined}
              fallback={getInitials(topic.author.name)}
              shape="circle"
              size="xs"
            />
            <span className="truncate">{topic.author.name}</span>
            <span aria-hidden>·</span>
            <time dateTime={topic.createdAt}>
              {formatTimeAgo(new Date(topic.createdAt))}
            </time>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <MessageSquare01 size={14} />
            {topic.replyCount}
          </span>
          <span title={t("forum.lastActivity")}>
            {formatTimeAgo(new Date(topic.lastActivityAt))}
          </span>
        </div>
      </button>
    </li>
  );
}
