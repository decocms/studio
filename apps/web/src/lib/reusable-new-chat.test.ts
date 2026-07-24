import { describe, expect, it } from "bun:test";
import type { Task } from "@/components/chat/task/types";
import { findReusableNewChat } from "./reusable-new-chat";

const USER = "user-1";

const task = (over: Partial<Task>): Task => ({
  id: over.id ?? crypto.randomUUID(),
  title: over.title ?? "New chat",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  virtual_mcp_id: "agent-1",
  created_by: USER,
  ...over,
});

describe("findReusableNewChat", () => {
  it("reuses an empty New chat for the agent", () => {
    const t = task({ id: "a" });
    expect(findReusableNewChat([t], "agent-1", USER)?.id).toBe("a");
  });

  it("does not reuse a chat belonging to another agent", () => {
    const t = task({ id: "a", virtual_mcp_id: "agent-2" });
    expect(findReusableNewChat([t], "agent-1", USER)).toBeUndefined();
  });

  // The incident this guard exists for: the thread list is org-wide (includes
  // teammates' threads), so without scoping to the current user, landing on
  // `/$org` reused a teammate's empty "New chat" and stranded the user on a
  // read-only thread that wasn't theirs.
  it("does not reuse a New chat created by another user", () => {
    const t = task({ id: "a", created_by: "user-2" });
    expect(findReusableNewChat([t], "agent-1", USER)).toBeUndefined();
  });

  it("does not reuse any thread when the user is unknown", () => {
    const t = task({ id: "a" });
    expect(findReusableNewChat([t], "agent-1", undefined)).toBeUndefined();
  });

  it("does not reuse a titled (already-run) chat", () => {
    const t = task({ id: "a", title: "Fix the login bug" });
    expect(findReusableNewChat([t], "agent-1", USER)).toBeUndefined();
  });

  it("does not reuse a hidden chat", () => {
    const t = task({ id: "a", hidden: true });
    expect(findReusableNewChat([t], "agent-1", USER)).toBeUndefined();
  });

  // The regression this guard exists for: a first message that FAILED leaves
  // the thread titled "New chat" but with a pinned harness_id, so it is
  // non-empty and runtime-locked. Reusing it strands the user on the broken
  // conversation.
  it("does not reuse a New chat whose first message pinned a harness", () => {
    const t = task({ id: "a", harness_id: "decopilot" });
    expect(findReusableNewChat([t], "agent-1", USER)).toBeUndefined();
  });

  it("picks the empty New chat over a failed same-titled one", () => {
    const failed = task({ id: "failed", harness_id: "claude-code" });
    const fresh = task({ id: "fresh" });
    expect(findReusableNewChat([failed, fresh], "agent-1", USER)?.id).toBe(
      "fresh",
    );
  });
});
