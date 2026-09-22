import { useNavigate, useSearch } from "@tanstack/react-router";
import { Mail01 } from "@untitledui/icons";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { useT } from "@/i18n/use-t";

export function useForumSearch() {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const filter: "all" | "mentions" | "unread" | "unread_mentions" =
    search.forumFilter === "mentions" ||
    search.forumFilter === "unread" ||
    search.forumFilter === "unread_mentions"
      ? search.forumFilter
      : "all";
  const mentions = filter === "mentions" || filter === "unread_mentions";
  const unread = filter === "unread" || filter === "unread_mentions";
  const sort = "personal" as const;
  const toggle = (key: "mentions" | "unread") => {
    const nextMentions = key === "mentions" ? !mentions : mentions;
    const nextUnread = key === "unread" ? !unread : unread;
    void navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        forumFilter: nextMentions
          ? nextUnread
            ? "unread_mentions"
            : "mentions"
          : nextUnread
            ? "unread"
            : undefined,
      }),
      replace: true,
      resetScroll: false,
    });
  };
  return { filter, sort, mentions, unread, toggle } as const;
}

export function ForumControls() {
  const t = useT();
  const { unread, toggle } = useForumSearch();
  return (
    <IconButton
      label={t("taskBoard.forum.unread")}
      tooltipSide="bottom"
      variant={unread ? "default" : "secondary"}
      aria-pressed={unread}
      onClick={() => toggle("unread")}
    >
      <Mail01 />
    </IconButton>
  );
}
