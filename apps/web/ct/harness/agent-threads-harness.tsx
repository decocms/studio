import { useState } from "react";
import {
  CommentThreadCard,
  NewCommentComposer,
  type CommentAuthor,
  type CommentRun,
  type TaskComment,
} from "@/layouts/task-board/task-comments";

const ME: CommentAuthor = { id: "u1", name: "valls" };
const AGENT: CommentAuthor = {
  id: "super-agent",
  name: "Super Agent",
  isAgent: true,
};

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 16, 12, minute)).toISOString();

const FINISHED: TaskComment = {
  id: "t1",
  author: ME,
  body: "[@Super Agent](mention:super-agent) implement the badge precedence from the description and open a PR.",
  createdAt: at(0),
  run: { status: "done", onOpen: () => {} },
  replies: [
    {
      id: "t1-r1",
      author: AGENT,
      body: "Done. The promotional badge now wins over the default one on the product page, and the listing uses the same rule. PR: acme/storefront#128.",
      createdAt: at(14),
      replies: [],
    },
  ],
};

const RUNNING: TaskComment = {
  id: "t2",
  author: ME,
  body: "[@Super Agent](mention:super-agent) the cart test is flaky on the PR, take a look.",
  createdAt: at(20),
  run: { status: "running", onOpen: () => {} },
  replies: [
    {
      id: "t2-r1",
      author: AGENT,
      body: "Reproduced it: the test reads the cart before the add-to-cart request settles. Fixing the wait now.",
      createdAt: at(23),
      replies: [],
    },
  ],
};

/**
 * CT surface for Super Agent run threads: a finished run, optionally a run in
 * progress, and the task composer routed the way the dialog routes it. Posts
 * do what the server is meant to: a mention starts a run in a new thread, or
 * lands in the live run's thread, and a reply to a finished run resumes it.
 */
export function AgentThreadsHarness({ running = true }: { running?: boolean }) {
  const [threads, setThreads] = useState<TaskComment[]>(
    running
      ? [FINISHED, RUNNING]
      : [FINISHED, { ...RUNNING, run: { status: "done", onOpen: () => {} } }],
  );
  const live = threads.some(
    (thread) =>
      thread.run?.status === "running" || thread.run?.status === "waiting",
  );
  const nowRunning: CommentRun = { status: "running", onOpen: () => {} };
  const post = (body: string, parentId?: string) =>
    setThreads((prev) => {
      const comment: TaskComment = {
        id: `p${prev.length}-${body.length}`,
        author: ME,
        body,
        createdAt: at(30),
        replies: [],
      };
      if (parentId) {
        return prev.map((thread) =>
          thread.id === parentId
            ? {
                ...thread,
                replies: [...thread.replies, comment],
                run: thread.run && nowRunning,
              }
            : thread,
        );
      }
      const mentionsAgent = body.includes("mention:super-agent");
      return [
        ...prev,
        mentionsAgent ? { ...comment, run: nowRunning } : comment,
      ];
    });

  return (
    <div className="flex w-[720px] flex-col gap-5 bg-background p-6">
      {threads.map((thread) => (
        <CommentThreadCard
          key={thread.id}
          thread={thread}
          me={ME}
          onEdit={async () => true}
          onDelete={() => {}}
          onReply={(body) => post(body, thread.id)}
          liveRunElsewhere={
            live &&
            thread.run?.status !== "running" &&
            thread.run?.status !== "waiting"
          }
        />
      ))}
      <NewCommentComposer
        agentRoute={live ? "steer" : "start"}
        onSubmit={(body) => {
          const liveThread = threads.find(
            (thread) => thread.run?.status === "running",
          );
          post(
            body,
            liveThread && body.includes("mention:super-agent")
              ? liveThread.id
              : undefined,
          );
        }}
      />
    </div>
  );
}
