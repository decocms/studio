import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  CommentThreadCard,
  NewCommentComposer,
  type CommentAuthor,
  type TaskComment,
} from "@/layouts/task-board/task-comments";

const ME: CommentAuthor = { id: "u1", name: "valls" };
const AGENT: CommentAuthor = {
  id: "super-agent",
  name: "Super Agent",
  isAgent: true,
};

const THREAD: TaskComment = {
  id: "c1",
  author: ME,
  body: "Can you take this one and open a PR?",
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
 * reply composer) and the new-comment composer. Mirrors the reply/delete/resolve
 * semantics of `useTaskBoardComments` on a single thread. Posted bodies are
 * dumped into a testid'd <pre> so specs can assert what the composer submitted.
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
        onSubmit={(body) => setPosted((prev) => [...prev, body])}
      />
      <pre data-testid="posted">{JSON.stringify(posted)}</pre>
    </div>
  );
}

/**
 * The same composer, inside a real modal dialog — which is where it actually
 * lives (the task dialog).
 *
 * Worth its own harness because a modal changes the rules around it: Radix
 * puts `pointer-events: none` on the body while it's open and traps focus, so
 * anything the composer portals out to the body is unclickable and unscrollable
 * even though it renders. The bare mount above cannot show that.
 */
export function TaskCommentsDialogHarness() {
  const [posted, setPosted] = useState<string[]>([]);

  return (
    <Dialog open>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[90vh] sm:max-w-[1040px]">
        <DialogTitle className="sr-only">Task</DialogTitle>
        <div className="flex flex-1 flex-col justify-end overflow-y-auto p-6">
          <NewCommentComposer
            me={ME}
            onSubmit={(body) => setPosted((prev) => [...prev, body])}
          />
        </div>
        <pre data-testid="posted">{JSON.stringify(posted)}</pre>
      </DialogContent>
    </Dialog>
  );
}
