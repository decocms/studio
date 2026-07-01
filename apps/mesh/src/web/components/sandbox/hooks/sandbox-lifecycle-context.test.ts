import { describe, expect, test } from "bun:test";
import {
  selectVmEntry,
  shouldAutoStart,
  shouldSelfHeal,
  shouldReconcileStaleCache,
  computeDrawerStatus,
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
  };

  test("all conditions met → true", () => {
    expect(shouldAutoStart(base)).toBe(true);
  });

  test("no github repo → false", () => {
    expect(shouldAutoStart({ ...base, hasActiveGithubRepo: false })).toBe(
      false,
    );
  });

  test("no userId → false", () => {
    expect(shouldAutoStart({ ...base, userId: null })).toBe(false);
  });

  test("no branch → true (server generates branch on SANDBOX_START)", () => {
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
  };

  test("fresh dead vm → true", () => {
    expect(shouldSelfHeal(base)).toBe(true);
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

describe("shouldReconcileStaleCache", () => {
  const base = {
    phase: "running" as string | null,
    previewUrl: null as string | null,
    userStopped: false,
    alreadyReconciled: false,
  };

  test("running with no previewUrl in cache → true", () => {
    expect(shouldReconcileStaleCache(base)).toBe(true);
  });

  test("previewUrl already present → false", () => {
    expect(
      shouldReconcileStaleCache({ ...base, previewUrl: "https://x" }),
    ).toBe(false);
  });

  test("still booting (not running) → false", () => {
    expect(shouldReconcileStaleCache({ ...base, phase: "starting" })).toBe(
      false,
    );
  });

  test("no phase yet → false", () => {
    expect(shouldReconcileStaleCache({ ...base, phase: null })).toBe(false);
  });

  test("user stopped → false", () => {
    expect(shouldReconcileStaleCache({ ...base, userStopped: true })).toBe(
      false,
    );
  });

  test("already reconciled for this arrival → false", () => {
    expect(
      shouldReconcileStaleCache({ ...base, alreadyReconciled: true }),
    ).toBe(false);
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
});
