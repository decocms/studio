import { describe, expect, it } from "bun:test";
import type { Task } from "@/components/chat/task/types";
import { findAgentEntryThread, findReusableNewChat } from "./reusable-new-chat";

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

  // Reusing a chat stamped with the other runtime drops the user into the wrong kind of session.
  describe("runtime", () => {
    const cms = task({ id: "cms", metadata: { runtime: "cms" } });
    const sandbox = task({ id: "sandbox", metadata: { runtime: "sandbox" } });
    const unstamped = task({ id: "legacy" });

    it("skips a sandbox-stamped empty chat when a new chat would be cms", () => {
      expect(
        findReusableNewChat([sandbox], "agent-1", USER, "cms"),
      ).toBeUndefined();
    });

    it("skips a cms-stamped empty chat when a new chat would be sandbox", () => {
      expect(
        findReusableNewChat([cms], "agent-1", USER, "sandbox"),
      ).toBeUndefined();
    });

    it("reuses the matching stamp", () => {
      expect(
        findReusableNewChat([sandbox, cms], "agent-1", USER, "cms")?.id,
      ).toBe("cms");
    });

    it("reuses an unstamped row for either runtime", () => {
      expect(findReusableNewChat([unstamped], "agent-1", USER, "cms")?.id).toBe(
        "legacy",
      );
      expect(
        findReusableNewChat([unstamped], "agent-1", USER, "sandbox")?.id,
      ).toBe("legacy");
    });

    // A /watch synthetic has no metadata: absent is "not loaded", not "unstamped".
    it("never reuses a partial row when a runtime is expected", () => {
      const partial = task({ id: "partial", partial: true });
      expect(
        findReusableNewChat([partial], "agent-1", USER, "cms"),
      ).toBeUndefined();
      expect(findReusableNewChat([partial], "agent-1", USER)?.id).toBe(
        "partial",
      );
    });

    it("an unresolved project keeps the pre-existing unfiltered behavior", () => {
      expect(findReusableNewChat([sandbox], "agent-1", USER)?.id).toBe(
        "sandbox",
      );
    });
  });
});

describe("findAgentEntryThread", () => {
  const empty = task({
    id: "empty",
    title: "New chat",
    updated_at: "2026-01-01T00:00:00Z",
  });
  const lastReal = task({
    id: "last",
    title: "Fix the login bug",
    harness_id: "claude-code",
    branch: "tavano-newbranch",
    updated_at: "2026-02-01T00:00:00Z",
  });

  // Inverts the old always-reuse-empty behavior that stranded repo-backed agents on the empty chat's stale branch.
  it("resumes the most-recent real thread (last branch) for a repo-backed agent", () => {
    expect(
      findAgentEntryThread([empty, lastReal], "agent-1", USER, undefined, true)
        ?.id,
    ).toBe("last");
  });

  it("keeps reusing the empty chat for a branchless agent", () => {
    expect(
      findAgentEntryThread([empty, lastReal], "agent-1", USER, undefined, false)
        ?.id,
    ).toBe("empty");
  });

  it("falls back to the empty chat when a repo-backed agent has no real thread", () => {
    expect(
      findAgentEntryThread([empty], "agent-1", USER, undefined, true)?.id,
    ).toBe("empty");
  });

  it("returns undefined when nothing matches (caller mints a fresh id)", () => {
    expect(
      findAgentEntryThread([], "agent-1", USER, undefined, true),
    ).toBeUndefined();
  });

  const onRelease = task({
    id: "release",
    title: "Edit hero",
    harness_id: "claude-code",
    branch: "tavano-teste",
    updated_at: "2026-02-01T00:00:00Z",
  });
  const newerUnnamedDraft = task({
    id: "draft",
    title: "Scratch",
    harness_id: "claude-code",
    branch: "tavano-unnamed",
    updated_at: "2026-03-01T00:00:00Z",
  });
  const known = new Set(["main", "tavano-teste"]);

  // Guards against re-entry landing on a newer unnamed draft (phantom "Rascunho") instead of the named release being edited.
  it("prefers the last thread on a named version over a newer unnamed draft", () => {
    expect(
      findAgentEntryThread(
        [onRelease, newerUnnamedDraft],
        "agent-1",
        USER,
        undefined,
        true,
        { knownBranches: known },
      )?.id,
    ).toBe("release");
  });

  it("falls back to the raw last thread when none sits on a named version", () => {
    expect(
      findAgentEntryThread(
        [newerUnnamedDraft],
        "agent-1",
        USER,
        undefined,
        true,
        {
          knownBranches: known,
        },
      )?.id,
    ).toBe("draft");
  });

  // Drafts mode: an unnamed draft is never editable, so it is never auto-resumed.
  it("drafts mode resumes the named version, ignoring a newer unnamed draft", () => {
    expect(
      findAgentEntryThread(
        [onRelease, newerUnnamedDraft],
        "agent-1",
        USER,
        undefined,
        true,
        { knownBranches: known, draftsMode: true },
      )?.id,
    ).toBe("release");
  });

  it("drafts mode returns undefined when nothing sits on a named version (caller mints on production)", () => {
    expect(
      findAgentEntryThread(
        [newerUnnamedDraft],
        "agent-1",
        USER,
        undefined,
        true,
        {
          knownBranches: known,
          draftsMode: true,
        },
      ),
    ).toBeUndefined();
  });

  it("never resumes a thread of the other runtime for a repo-backed agent", () => {
    const cmsReal = task({
      id: "cms-real",
      title: "Edit copy",
      harness_id: "decopilot",
      metadata: { runtime: "cms" },
      updated_at: "2026-03-01T00:00:00Z",
    });
    const sandboxEmpty = task({
      id: "sandbox-empty",
      metadata: { runtime: "sandbox" },
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect(
      findAgentEntryThread(
        [cmsReal, sandboxEmpty],
        "agent-1",
        USER,
        "sandbox",
        true,
      )?.id,
    ).toBe("sandbox-empty");
  });
});
