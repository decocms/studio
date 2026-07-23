import { describe, expect, test } from "bun:test";
import {
  selectVmEntry,
  shouldAutoStart,
  shouldSelfHeal,
  computeDrawerStatus,
  buildSandboxStartArgs,
  deriveOthersThreadLabel,
  computeOthersThreadGate,
  type BranchMapEntryLike,
} from "./sandbox-lifecycle-context";

const entry = (
  kind: string,
  handle = "h1",
  url: string | null = "https://example/preview",
): BranchMapEntryLike => ({
  sandboxHandle: handle,
  previewUrl: url,
  sandboxProviderKind: kind,
});

describe("selectVmEntry", () => {
  test("returns null on empty map", () => {
    expect(selectVmEntry({})).toBeNull();
  });

  test("prefers a non-user-desktop entry over a user-desktop entry", () => {
    const result = selectVmEntry({
      a: entry("user-desktop", "desk"),
      b: entry("agent-sandbox", "vm"),
    });
    expect(result?.sandboxHandle).toBe("vm");
  });

  test("falls back to first entry when all are user-desktop", () => {
    const result = selectVmEntry({
      a: entry("user-desktop", "first"),
      b: entry("user-desktop", "second"),
    });
    expect(result?.sandboxHandle).toBe("first");
  });

  test("returns the only entry when one is present", () => {
    expect(
      selectVmEntry({ a: entry("agent-sandbox", "solo") })?.sandboxHandle,
    ).toBe("solo");
  });
});

describe("shouldAutoStart", () => {
  const base = {
    hasActiveGithubRepo: true,
    userId: "u1",
    branch: "main",
    vmEntry: null,
    userStopped: false,
    isPending: false,
    attempted: false,
    autoStartBlocked: false,
  };

  test("all conditions met → true", () => {
    expect(shouldAutoStart(base)).toBe(true);
  });

  test("blocked on another member's thread → false", () => {
    expect(shouldAutoStart({ ...base, autoStartBlocked: true })).toBe(false);
  });

  test("no github repo → false", () => {
    expect(shouldAutoStart({ ...base, hasActiveGithubRepo: false })).toBe(
      false,
    );
  });

  test("no userId → false", () => {
    expect(shouldAutoStart({ ...base, userId: null })).toBe(false);
  });

  test("no branch → true (server assigns staging on SANDBOX_START)", () => {
    expect(shouldAutoStart({ ...base, branch: null })).toBe(true);
  });

  test("vmEntry already present → false", () => {
    expect(
      shouldAutoStart({
        ...base,
        vmEntry: entry("agent-sandbox"),
      }),
    ).toBe(false);
  });

  test("user stopped → false", () => {
    expect(shouldAutoStart({ ...base, userStopped: true })).toBe(false);
  });

  test("start already pending → false", () => {
    expect(shouldAutoStart({ ...base, isPending: true })).toBe(false);
  });

  test("already attempted for this branch → false", () => {
    expect(shouldAutoStart({ ...base, attempted: true })).toBe(false);
  });
});

describe("shouldSelfHeal", () => {
  const base = {
    notFound: true,
    deadVmId: "vm-dead",
    lastDeadVmId: null as string | null,
    isPending: false,
    userStopped: false,
    autoStartBlocked: false,
  };

  test("fresh dead vm → true", () => {
    expect(shouldSelfHeal(base)).toBe(true);
  });

  test("blocked on another member's thread → false (no silent reprovision)", () => {
    expect(shouldSelfHeal({ ...base, autoStartBlocked: true })).toBe(false);
  });

  test("not notFound → false", () => {
    expect(shouldSelfHeal({ ...base, notFound: false })).toBe(false);
  });

  test("no deadVmId → false", () => {
    expect(shouldSelfHeal({ ...base, deadVmId: null })).toBe(false);
  });

  test("already reprovisioned for this vm → false", () => {
    expect(shouldSelfHeal({ ...base, lastDeadVmId: "vm-dead" })).toBe(false);
  });

  test("start already pending → false", () => {
    expect(shouldSelfHeal({ ...base, isPending: true })).toBe(false);
  });

  test("user stopped → false", () => {
    expect(shouldSelfHeal({ ...base, userStopped: true })).toBe(false);
  });
});

describe("buildSandboxStartArgs", () => {
  test("includes sandboxProviderKind when the thread has a locked kind", () => {
    // Regression: user-driven start/retry/resume used to omit
    // sandboxProviderKind (unlike auto-start/self-heal), so retrying a
    // failed locked-provider thread could get provisioned on the wrong
    // provider instead of the one the preview is locked to.
    expect(buildSandboxStartArgs("vmcp1", "main", "user-desktop")).toEqual({
      virtualMcpId: "vmcp1",
      branch: "main",
      sandboxProviderKind: "user-desktop",
    });
  });

  test("omits branch and sandboxProviderKind when absent", () => {
    expect(buildSandboxStartArgs("vmcp1", null, null)).toEqual({
      virtualMcpId: "vmcp1",
    });
  });
});

describe("computeDrawerStatus", () => {
  test("suspended → suspended", () => {
    expect(computeDrawerStatus({ kind: "suspended" })).toBe("suspended");
  });

  test("starting → starting", () => {
    expect(computeDrawerStatus({ kind: "starting" })).toBe("starting");
  });

  test("iframe → running", () => {
    expect(
      computeDrawerStatus({ kind: "iframe", previewUrl: "https://x" }),
    ).toBe("running");
  });

  test("errored → errored", () => {
    expect(
      computeDrawerStatus({
        kind: "errored",
        error: { code: null, message: "boom" },
      }),
    ).toBe("errored");
  });

  test("othersThread → idle", () => {
    expect(computeDrawerStatus({ kind: "othersThread", label: "main" })).toBe(
      "idle",
    );
  });
});

describe("deriveOthersThreadLabel", () => {
  test("own thread (created_by === userId) → null", () => {
    expect(
      deriveOthersThreadLabel({
        userId: "u1",
        createdBy: "u1",
        branch: "main",
        title: "New chat",
      }),
    ).toBeNull();
  });

  test("no userId → null (unauthenticated, don't gate)", () => {
    expect(
      deriveOthersThreadLabel({
        userId: null,
        createdBy: "u2",
        branch: "main",
        title: "New chat",
      }),
    ).toBeNull();
  });

  test("no created_by → null (own/new unsaved thread)", () => {
    expect(
      deriveOthersThreadLabel({
        userId: "u1",
        createdBy: null,
        branch: "main",
        title: "New chat",
      }),
    ).toBeNull();
  });

  test("others thread with a branch → branch label", () => {
    expect(
      deriveOthersThreadLabel({
        userId: "u1",
        createdBy: "u2",
        branch: "tavano-321312",
        title: "New chat",
      }),
    ).toBe("tavano-321312");
  });

  test("others thread with no branch → title fallback", () => {
    expect(
      deriveOthersThreadLabel({
        userId: "u1",
        createdBy: "u2",
        branch: null,
        title: "Fix the banner",
      }),
    ).toBe("Fix the banner");
  });

  test("others thread with neither branch nor title → null", () => {
    expect(
      deriveOthersThreadLabel({
        userId: "u1",
        createdBy: "u2",
        branch: null,
        title: null,
      }),
    ).toBeNull();
  });
});

describe("computeOthersThreadGate", () => {
  test("own thread (no label) → not blocked regardless of ack", () => {
    expect(
      computeOthersThreadGate({
        othersThreadLabel: null,
        acknowledgedThreadId: null,
        threadId: "t1",
      }).autoStartBlocked,
    ).toBe(false);
  });

  test("others thread, never acknowledged → blocked", () => {
    expect(
      computeOthersThreadGate({
        othersThreadLabel: "main",
        acknowledgedThreadId: null,
        threadId: "t1",
      }).autoStartBlocked,
    ).toBe(true);
  });

  test("others thread, acknowledged this thread → not blocked", () => {
    expect(
      computeOthersThreadGate({
        othersThreadLabel: "main",
        acknowledgedThreadId: "t1",
        threadId: "t1",
      }).autoStartBlocked,
    ).toBe(false);
  });

  test("acknowledged a DIFFERENT thread → blocked (re-arms per thread)", () => {
    expect(
      computeOthersThreadGate({
        othersThreadLabel: "main",
        acknowledgedThreadId: "t1",
        threadId: "t2",
      }).autoStartBlocked,
    ).toBe(true);
  });

  test("acknowledgement survives a null → assigned branch on the same thread", () => {
    // Same thread id, so acknowledging while branch was null stays valid once
    // the server assigns staging — no re-prompt, no double SANDBOX_START.
    const acked = computeOthersThreadGate({
      othersThreadLabel: "New chat", // title fallback (branch was null)
      acknowledgedThreadId: "t1",
      threadId: "t1",
    });
    expect(acked.autoStartBlocked).toBe(false);
  });
});
