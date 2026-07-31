import { useState } from "react";
import {
  CommentThreadCard,
  NewCommentComposer,
  type CommentAuthor,
  type Mentionable,
  type TaskComment,
} from "@/layouts/task-board/task-comments";

const ME: CommentAuthor = { id: "u1", name: "valls" };
const AGENT: CommentAuthor = {
  id: "super-agent",
  name: "Super Agent",
  isAgent: true,
};

const MENTIONABLES: Mentionable[] = [
  { kind: "user", id: "super-agent", label: "Super Agent", isAgent: true },
  { kind: "user", id: "u1", label: "valls" },
  { kind: "user", id: "u2", label: "aline" },
  { kind: "user", id: "u3", label: "beatriz.ramos" },
  { kind: "task", id: "t1", label: "Error screens", status: "todo" },
  {
    kind: "task",
    id: "t2",
    label: "Fix the model picker",
    status: "in_review",
  },
];

const THREAD: TaskComment = {
  id: "c1",
  author: ME,
  body: "@Super Agent can you take this one and open a PR?",
  createdAt: new Date("2026-07-30T12:00:00Z").toISOString(),
  replies: [
    {
      id: "c1-r1",
      author: AGENT,
      body: "On it. I will start from the description and report back here when the PR is up.",
      createdAt: new Date("2026-07-30T12:01:00Z").toISOString(),
      replies: [],
    },
  ],
};

/**
 * CT surface for task comments: one thread card (root + agent reply + inline
 * reply composer) and the new-comment composer, with a fixed mention list so
 * the `@` menu is deterministic. Local state stands in for the server's
 * reply/delete/resolve round-trips — this is a view test, not a wiring one.
 * Posted bodies are dumped into a testid'd <pre> so specs can assert what the
 * composer submitted.
 */
export function TaskCommentsHarness() {
  const [thread, setThread] = useState<TaskComment | null>(THREAD);
  const [posted, setPosted] = useState<string[]>([]);

  return (
    <div className="flex w-[640px] flex-col gap-5 bg-background p-6">
      {thread && (
        <CommentThreadCard
          thread={thread}
          me={ME}
          mentionables={MENTIONABLES}
          onReply={(body) =>
            setThread((prev) =>
              prev
                ? {
                    ...prev,
                    replies: [
                      ...prev.replies,
                      {
                        id: `r-${prev.replies.length}`,
                        author: ME,
                        body,
                        createdAt: new Date(
                          "2026-07-30T12:02:00Z",
                        ).toISOString(),
                        replies: [],
                      },
                    ],
                  }
                : prev,
            )
          }
          onDelete={(commentId) =>
            setThread((prev) => {
              if (!prev) return prev;
              if (commentId === prev.id) return null;
              return {
                ...prev,
                replies: prev.replies.filter((r) => r.id !== commentId),
              };
            })
          }
          onToggleResolved={() =>
            setThread((prev) =>
              prev ? { ...prev, resolved: !prev.resolved } : prev,
            )
          }
        />
      )}
      <NewCommentComposer
        me={ME}
        mentionables={MENTIONABLES}
        onSubmit={(body) => setPosted((prev) => [...prev, body])}
      />
      <pre data-testid="posted">{JSON.stringify(posted)}</pre>
    </div>
  );
}
