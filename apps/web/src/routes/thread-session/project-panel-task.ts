import type { ChatTaskContextValue } from "@/components/chat/context";
import type { Task } from "@/components/chat/task/types";

/**
 * The task context a project's main panel sees when it keeps its own draft
 * thread beside another agent's chat.
 *
 * Every field that names the session is the panel's: sandbox requests send
 * `taskId` as `?thread=`, and the server reads that thread's runtime stamp.
 * Left on the chat's thread, a Fast Preview draft is asked about as a coding
 * session and its git status fails with "Sandbox handle is gone".
 */
export function projectPanelTaskValue(
  chat: ChatTaskContextValue,
  task: Task | null,
  setBranch: (threadId: string, branch: string | null) => void,
): ChatTaskContextValue {
  return {
    ...chat,
    taskId: task?.id ?? null,
    activeTask: task,
    isThreadLocked: task?.harness_id != null,
    lockedHarness: task?.harness_id ?? null,
    lockedBranch: task?.branch ?? null,
    currentBranch: task?.branch ?? null,
    setCurrentTaskBranch: (branch) => {
      if (task) setBranch(task.id, branch);
    },
  };
}
