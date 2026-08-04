import { expect, test } from "bun:test";
import type { GithubRepo } from "@decocms/shared/sdk";
import {
  resolveSandboxBranch,
  syntheticBranchToGitRef,
  threadBranch,
  threadIdFromBranch,
} from "./thread-repo";

test("threadBranch round-trips through threadIdFromBranch", () => {
  const id = "f3ef4465-b187-4e8d-b71a-a36cf4035046";
  expect(threadIdFromBranch(threadBranch(id))).toBe(id);
  expect(
    threadIdFromBranch(threadBranch(id, "conn_6-MnS2eSZ3z-2BBVwFQrR")),
  ).toBe(id);
});

test("threadBranch encodes the connection id so repos get distinct branches", () => {
  const id = "t1";
  expect(threadBranch(id, "conn_a")).not.toBe(threadBranch(id, "conn_b"));
  expect(threadBranch(id, "conn_a")).toBe("thread:t1/conn_a");
});

test("threadIdFromBranch ignores non-thread branches", () => {
  expect(threadIdFromBranch("ephemeral")).toBeNull();
  expect(threadIdFromBranch("main")).toBeNull();
  expect(threadIdFromBranch(null)).toBeNull();
});

test("syntheticBranchToGitRef maps a synthetic key to a real, valid, non-default ref", () => {
  expect(syntheticBranchToGitRef("thread:t1")).toBe("sandbox/thread-t1");
  expect(syntheticBranchToGitRef("thread:t1/conn_a")).toBe(
    "sandbox/thread-t1-conn_a",
  );
  // Never the repo default — that is the whole point (no push to main).
  for (const ref of ["thread:t1", "thread:t1/conn_a"]) {
    const out = syntheticBranchToGitRef(ref);
    expect(out).not.toBe("main");
    expect(out).not.toBe("master");
    // Valid git ref charset: no colon (the synthetic separator) survives.
    expect(out.includes(":")).toBe(false);
    expect(/^[A-Za-z0-9._/-]+$/.test(out)).toBe(true);
  }
});

test("syntheticBranchToGitRef is deterministic and per-thread distinct (restore + isolation)", () => {
  expect(syntheticBranchToGitRef(threadBranch("t1"))).toBe(
    syntheticBranchToGitRef(threadBranch("t1")),
  );
  expect(syntheticBranchToGitRef(threadBranch("t1", "conn_a"))).not.toBe(
    syntheticBranchToGitRef(threadBranch("t2", "conn_a")),
  );
});

// `resolveSandboxBranch` is the single derivation shared by the decopilot fs
// tools and the sandbox-hosted dispatch path. Two derivations that drift
// provision two pods for one thread, so each regime is pinned here.

test("a thread-bound repo wins and pins its own branch", () => {
  expect(
    resolveSandboxBranch({
      threadId: "t1",
      threadRepo: { connectionId: "conn_a" } as GithubRepo,
      agentRepo: { connectionId: "conn_b" } as GithubRepo,
      runBranch: "main",
    }),
  ).toBe("thread:t1/conn_a");
});

test("an agent with no repo at all shares one ephemeral sandbox", () => {
  expect(resolveSandboxBranch({ threadId: "t1", threadRepo: null })).toBe(
    "ephemeral",
  );
  expect(
    resolveSandboxBranch({ threadId: "t2", threadRepo: null, agentRepo: null }),
  ).toBe("ephemeral");
});

test("a repo-agent uses the run's branch when it has one", () => {
  expect(
    resolveSandboxBranch({
      threadId: "t1",
      threadRepo: null,
      agentRepo: { connectionId: "conn_b" } as GithubRepo,
      runBranch: "feature/x",
    }),
  ).toBe("feature/x");
});

test("a repo-agent with no branch yet falls back to a per-thread branch", () => {
  expect(
    resolveSandboxBranch({
      threadId: "t1",
      threadRepo: null,
      agentRepo: { connectionId: "conn_b" } as GithubRepo,
    }),
  ).toBe("thread:t1");
  // Null and undefined must behave identically — the callers supply both.
  expect(
    resolveSandboxBranch({
      threadId: "t1",
      threadRepo: null,
      agentRepo: { connectionId: "conn_b" } as GithubRepo,
      runBranch: null,
    }),
  ).toBe("thread:t1");
});

test("different threads of one repo-agent never share a branch", () => {
  const agentRepo = { connectionId: "conn_b" } as GithubRepo;
  expect(
    resolveSandboxBranch({ threadId: "t1", threadRepo: null, agentRepo }),
  ).not.toBe(
    resolveSandboxBranch({ threadId: "t2", threadRepo: null, agentRepo }),
  );
});

// A task run dispatched with no repo runs on the bare `thread:<id>` key and
// clones into that pod mid-run (TASK_ADD_REPO). Re-deriving the key from the
// repo it added would move the claim handle off the pod holding the agent loop.
test("the bare thread key survives a repo bound mid-run", () => {
  expect(
    resolveSandboxBranch({
      threadId: "t1",
      threadRepo: { connectionId: "conn_a" } as GithubRepo,
      runBranch: "thread:t1",
    }),
  ).toBe("thread:t1");
});

test("only the bare key pins — load_repo's repo-scoped key still switches", () => {
  expect(
    resolveSandboxBranch({
      threadId: "t1",
      threadRepo: { connectionId: "conn_b" } as GithubRepo,
      runBranch: "thread:t1/conn_a",
    }),
  ).toBe("thread:t1/conn_b");
  // Another thread's bare key must not pin this one.
  expect(
    resolveSandboxBranch({
      threadId: "t1",
      threadRepo: { connectionId: "conn_a" } as GithubRepo,
      runBranch: "thread:t2",
    }),
  ).toBe("thread:t1/conn_a");
});

test("a repo-less run pinned to its own bare key does not join the ephemeral pool", () => {
  expect(
    resolveSandboxBranch({
      threadId: "t1",
      threadRepo: null,
      runBranch: "thread:t1",
    }),
  ).toBe("thread:t1");
});
