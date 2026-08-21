import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";
import { useThreadActions, useThreads } from "@/components/chat/store/hooks";
import { useStudioTools } from "@/lib/studio-tools";
import { usePanelActions } from "@/layouts/shell-layout";
import { useTaskBoardItemActions } from "@/hooks/use-task-board-items";
import { writeChatDraft } from "@/lib/chat-draft";
import { createMentionDoc } from "@/components/chat/tiptap/mention";
import type { TiptapDoc } from "@/components/chat/types";
import { buildTaskChatContext } from "@/layouts/task-board/build-task-chat-context";
import {
  resolveNewestSession,
  resolveTaskBranch,
} from "@/layouts/task-board/task-branch";

type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];

/**
 * Start another agent session inside a task.
 *
 * A task owns a branch and holds N sessions on it, so a new session inherits
 * the branch rather than starting a second one (see `resolveTaskBranch`) and is
 * linked to the task before we navigate. Shared by the task workspace's "New
 * session" and the chat panel's session tabs so there is one implementation of
 * what "another session on this task" means.
 */
export function useStartTaskSession() {
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const { create } = useThreadActions();
  const { threads } = useThreads();
  const { setTaskId } = usePanelActions();
  const actions = useTaskBoardItemActions();

  /** The branch this task's sessions share: local store first (the user's own
   *  sessions are cached with it), then the server for someone else's. */
  const taskBranch = async (task: TaskBoardItem): Promise<string | null> => {
    const local = resolveTaskBranch(
      task.threads.map((thread) => ({
        threadId: thread.threadId,
        createdAt: thread.createdAt,
        branch: threads.find((t) => t.id === thread.threadId)?.branch,
      })),
    );
    if (local) return local;
    const newest = resolveNewestSession(task.threads);
    if (!newest) return null;
    return await studio
      .call("COLLECTION_THREADS_GET", { id: newest.threadId })
      .then((r) => r.item?.branch?.trim() || null)
      .catch(() => null);
  };

  return async (task: TaskBoardItem) => {
    const newId = crypto.randomUUID();
    const agentId = getWellKnownDecopilotVirtualMCP(org.id).id;
    // Best-effort: the session opens regardless, just with less context.
    const prs = await studio
      .call("TASK_BOARD_ITEM_PRS_GET", { taskBoardItemId: task.id })
      .then((r) => r.prs)
      .catch(() => []);
    const context = buildTaskChatContext(task, prs);
    /** A removable task @ref chip, NOT auto-sent: the user reviews and adds to
     *  it, and the chip expands to the task context at send time. */
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            createMentionDoc({
              id: task.id,
              name: task.title,
              char: "@",
              kind: "task",
              metadata: {
                title: task.title,
                description: task.description,
                context,
              },
            }),
            { type: "text", text: " " },
          ],
        },
      ],
    };
    writeChatDraft(sessionStorage, locator, newId, doc);
    const branch = await taskBranch(task);
    try {
      await create({
        id: newId,
        virtual_mcp_id: agentId,
        ...(branch ? { branch } : {}),
      });
      // Best-effort: a link failure shouldn't block navigating into the chat.
      await actions.link.mutateAsync({ id: task.id, linkThreadId: newId });
    } catch {
      /* Toast already fired by the manager; navigate anyway so the route
         loader's ensure-fallback can retry the create. */
    }
    setTaskId(newId, agentId);
  };
}
