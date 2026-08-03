import { expect, test } from "bun:test";
import {
  isSandboxOwner,
  syntheticBranchToGitRef,
  threadBranch,
  threadBelongsToVirtualMcp,
  threadIdFromBranch,
} from "./thread-repo";

test("only the resolved sandbox owner has mutation authority", () => {
  expect(isSandboxOwner("user_1", "user_1")).toBe(true);
  expect(isSandboxOwner("user_viewer", "user_1")).toBe(false);
});

test("thread sandbox authority is scoped to its Virtual MCP", () => {
  const thread = { virtual_mcp_id: "vmcp_a", created_by: "user_1" };
  expect(threadBelongsToVirtualMcp(thread, "vmcp_a")).toBe(true);
  expect(threadBelongsToVirtualMcp(thread, "vmcp_b")).toBe(false);
});

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
