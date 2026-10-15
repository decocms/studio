import { ChevronUp } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useT } from "@/i18n/use-t.ts";
import { useForumMutations, type ForumTopic } from "./use-forum";

const STATUS_LABELS: Record<string, TranslationKey> = {
  todo: "forum.status.todo",
  in_progress: "forum.status.inProgress",
  in_review: "forum.status.inReview",
  done: "forum.status.done",
};

/** The topic's lane, shown only once it has left the default "open" lane. */
export function StatusPill({ status }: { status: string }) {
  const t = useT();
  const key = STATUS_LABELS[status];
  if (!key) return null;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium",
        status === "done"
          ? "bg-success/10 text-success"
          : "bg-muted text-muted-foreground",
      )}
    >
      {t(key)}
    </span>
  );
}

export function KindBadge({
  tag,
}: {
  tag: { name: string; color: string | null };
}) {
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-full border border-border px-2 text-xs text-muted-foreground">
      <span
        className="size-1.5 rounded-full"
        style={{ backgroundColor: tag.color ?? "currentColor" }}
      />
      {tag.name}
    </span>
  );
}

export function VoteButton({
  topic,
  size = "md",
}: {
  topic: Pick<ForumTopic, "id" | "votes" | "viewerVoted">;
  size?: "md" | "lg";
}) {
  const t = useT();
  const { vote } = useForumMutations();
  return (
    <button
      type="button"
      aria-pressed={topic.viewerVoted}
      aria-label={t("forum.vote")}
      disabled={vote.isPending}
      onClick={() => vote.mutate(topic.id)}
      className={cn(
        "flex shrink-0 cursor-pointer flex-col items-center justify-center rounded-lg border tabular-nums transition-colors",
        size === "lg" ? "h-14 w-12 text-sm" : "h-11 w-10 text-xs",
        topic.viewerVoted
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <ChevronUp size={size === "lg" ? 18 : 16} />
      <span className="font-medium">{topic.votes}</span>
    </button>
  );
}
