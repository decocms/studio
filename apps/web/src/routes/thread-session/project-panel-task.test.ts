import { describe, expect, mock, test } from "bun:test";
import type { ChatTaskContextValue } from "@/components/chat/context";
import type { Task } from "@/components/chat/task/types";
import { projectPanelTaskValue } from "./project-panel-task";

const chatThread: Task = {
  id: "thread-chat",
  title: "Assistant chat",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  virtual_mcp_id: "assistant",
  branch: "thread:thread-chat",
  harness_id: "claude-code",
  metadata: { runtime: "sandbox" },
};

const draftThread: Task = {
  id: "thread-draft",
  title: "New chat",
  created_at: "2026-01-02T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  virtual_mcp_id: "project",
  branch: "draft-branch",
  metadata: { runtime: "cms" },
};

const openTask = mock(() => {});

const chat: ChatTaskContextValue = {
  virtualMcpId: "project",
  taskId: chatThread.id,
  openTask,
  createTask: () => "thread-new",
  createTaskWithMessage: () => {},
  activeTask: chatThread,
  isThreadLocked: true,
  lockedHarness: "claude-code",
  lockedBranch: "thread:thread-chat",
  currentBranch: "thread:thread-chat",
  setCurrentTaskBranch: () => {},
};

describe("projectPanelTaskValue", () => {
  /**
   * INVERTED: the panel kept the chat's `taskId`, so its sandbox requests sent
   * `?thread=<chat thread>` with the draft's branch. The server read a thread
   * of another agent, could not use the draft's `cms` stamp, and a Fast
   * Preview draft's git status came back 410 "Sandbox handle is gone".
   */
  test("names the panel's draft thread, not the chat's", () => {
    const value = projectPanelTaskValue(chat, draftThread, () => {});
    expect(value.taskId).toBe("thread-draft");
    expect(value.activeTask).toBe(draftThread);
    expect(value.currentBranch).toBe("draft-branch");
    expect(value.lockedBranch).toBe("draft-branch");
    expect(value.isThreadLocked).toBe(false);
    expect(value.lockedHarness).toBeNull();
  });

  test("names no thread while the draft is still being resolved", () => {
    const value = projectPanelTaskValue(chat, null, () => {});
    expect(value.taskId).toBeNull();
    expect(value.activeTask).toBeNull();
    expect(value.currentBranch).toBeNull();
  });

  test("keeps the chat's navigation", () => {
    const value = projectPanelTaskValue(chat, draftThread, () => {});
    expect(value.openTask).toBe(openTask);
    expect(value.virtualMcpId).toBe("project");
  });

  test("moves the draft thread's branch, never the chat's", () => {
    const setBranch = mock((_id: string, _branch: string | null) => {});
    projectPanelTaskValue(chat, draftThread, setBranch).setCurrentTaskBranch(
      "next-draft",
    );
    expect(setBranch).toHaveBeenCalledWith("thread-draft", "next-draft");

    const unresolved = mock((_id: string, _branch: string | null) => {});
    projectPanelTaskValue(chat, null, unresolved).setCurrentTaskBranch("x");
    expect(unresolved).not.toHaveBeenCalled();
  });
});
