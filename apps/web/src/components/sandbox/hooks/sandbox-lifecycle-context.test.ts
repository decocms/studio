import { describe, expect, test } from "bun:test";
import type {
  SandboxProviderKind,
  SandboxRecord,
} from "@decocms/shared/sdk/types";
import {
  resolveSurfaceVmEntry,
  sandboxSurfaceKind,
  shouldAutoStart,
  shouldAdoptBranch,
  shouldSelfHeal,
  computeDrawerStatus,
  buildSandboxStartArgs,
  overlayThreadSandboxMap,
  deriveStartError,
  isRetryableClaimFailure,
  shouldAutoRetryClaim,
  reconcileClaimRetryEpisode,
  MAX_CLAIM_AUTO_RETRIES,
} from "./sandbox-lifecycle-context";

const entry = (
  kind: SandboxProviderKind,
  handle = "h1",
  url: string | null = "https://example/preview",
): SandboxRecord => ({
  sandboxHandle: handle,
  previewUrl: url,
  sandboxProviderKind: kind,
});

describe("sandboxSurfaceKind", () => {
  test("hosted web owns agent-sandbox", () => {
    expect(sandboxSurfaceKind(false)).toBe("agent-sandbox");
  });

  test("native owns user-desktop", () => {
    expect(sandboxSurfaceKind(true)).toBe("user-desktop");
  });
});

describe("resolveSurfaceVmEntry", () => {
  test("resolves the exact sandbox for the application surface", () => {
    const branchMap = {
      "user-desktop": entry("user-desktop", "desk"),
      "agent-sandbox": entry("agent-sandbox", "vm"),
    };

    expect(
      resolveSurfaceVmEntry(branchMap, "agent-sandbox")?.sandboxHandle,
    ).toBe("vm");
    expect(
      resolveSurfaceVmEntry(branchMap, "user-desktop")?.sandboxHandle,
    ).toBe("desk");
  });

  test("does not fall back to a sibling owned by another surface", () => {
    const result = resolveSurfaceVmEntry(
      { "user-desktop": entry("user-desktop", "desk") },
      "agent-sandbox",
    );
    expect(result).toBeNull();
  });

  test("returns null when the branch has no sandbox", () => {
    expect(resolveSurfaceVmEntry({}, "agent-sandbox")).toBeNull();
    expect(resolveSurfaceVmEntry({}, "user-desktop")).toBeNull();
  });

  test("uses the desktop entry even when a hosted sibling exists", () => {
    const result = resolveSurfaceVmEntry(
      {
        "user-desktop": entry("user-desktop", "desk"),
        "agent-sandbox": entry("agent-sandbox", "vm"),
      },
      "user-desktop",
    );
    expect(result?.sandboxHandle).toBe("desk");
  });
});

describe("shouldAutoStart", () => {
  const base = {
    executionEnabled: true,
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

  test("disabled execution boundary → false", () => {
    expect(shouldAutoStart({ ...base, executionEnabled: false })).toBe(false);
  });

  test("no github repo → false", () => {
    expect(shouldAutoStart({ ...base, hasActiveGithubRepo: false })).toBe(
      false,
    );
  });

  test("no userId → false", () => {
    expect(shouldAutoStart({ ...base, userId: null })).toBe(false);
  });

  // Inverted from "no branch → true": letting the server mint the branch here
  // raced COLLECTION_THREADS_CREATE's own mint and leaked an orphan sandbox
  // (see shouldAutoStart). Only the user-driven start() may go branchless.
  test("no branch → false (never let SANDBOX_START mint a branch)", () => {
    expect(shouldAutoStart({ ...base, branch: null })).toBe(false);
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

describe("shouldAdoptBranch", () => {
  const base = {
    threadLoaded: true,
    isOwner: true,
    hasActiveGithubRepo: true,
    branch: null as string | null,
    attempted: false,
  };

  test("loaded repo-backed thread with no branch → true", () => {
    expect(shouldAdoptBranch(base)).toBe(true);
  });

  // The whole point: shouldAutoStart refuses to start without a branch, so
  // without this these threads would never boot a preview at all.
  test("already has a branch → false", () => {
    expect(shouldAdoptBranch({ ...base, branch: "rafael-z9x1cbam" })).toBe(
      false,
    );
  });

  // A null branch on an unresolved row means "not known yet", not "none" —
  // minting here would race COLLECTION_THREADS_CREATE all over again.
  test("thread row not loaded → false", () => {
    expect(shouldAdoptBranch({ ...base, threadLoaded: false })).toBe(false);
  });

  test("teammate's thread → false (their row stays read-only)", () => {
    expect(shouldAdoptBranch({ ...base, isOwner: false })).toBe(false);
  });

  test("no repo → false (nothing to clone, so no branch is needed)", () => {
    expect(shouldAdoptBranch({ ...base, hasActiveGithubRepo: false })).toBe(
      false,
    );
  });

  test("already adopted for this thread → false", () => {
    expect(shouldAdoptBranch({ ...base, attempted: true })).toBe(false);
  });
});

describe("shouldSelfHeal", () => {
  const base = {
    executionEnabled: true,
    notFound: true,
    deadVmId: "vm-dead",
    lastDeadVmId: null as string | null,
    isPending: false,
    userStopped: false,
  };

  test("fresh dead vm → true", () => {
    expect(shouldSelfHeal(base)).toBe(true);
  });

  test("disabled execution boundary → false", () => {
    expect(shouldSelfHeal({ ...base, executionEnabled: false })).toBe(false);
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
  test("includes the branch when present", () => {
    expect(buildSandboxStartArgs("vmcp1", "main")).toEqual({
      virtualMcpId: "vmcp1",
      branch: "main",
    });
  });

  test("omits the branch when absent", () => {
    expect(buildSandboxStartArgs("vmcp1", null)).toEqual({
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
});

describe("overlayThreadSandboxMap", () => {
  const branch = "thread:t1/conn_1";
  const threadMap = {
    owner: { [branch]: { "agent-sandbox": entry("agent-sandbox", "the-one") } },
  } as never;

  test("re-keys the thread owner's record onto the viewer", () => {
    // A thread has ONE sandbox, recorded under its creator and resolved
    // server-side for whoever opens the thread (resolveSandboxUserId). The
    // viewer-keyed lookups downstream must find it, or auto-start boots a
    // second sandbox on the same git branch.
    const result = overlayThreadSandboxMap({
      agentSandboxMap: undefined,
      threadSandboxMap: threadMap,
      userId: "viewer",
      ownerId: "owner",
      branch,
    });
    expect(result?.viewer?.[branch]?.["agent-sandbox"]?.sandboxHandle).toBe(
      "the-one",
    );
  });

  test("own thread: ownerId absent falls back to the viewer", () => {
    const result = overlayThreadSandboxMap({
      agentSandboxMap: undefined,
      threadSandboxMap: {
        me: { [branch]: { "agent-sandbox": entry("agent-sandbox", "mine") } },
      } as never,
      userId: "me",
      ownerId: null,
      branch,
    });
    expect(result?.me?.[branch]?.["agent-sandbox"]?.sandboxHandle).toBe("mine");
  });

  test("keeps sibling branches on the agent's map", () => {
    const agentMap = {
      viewer: { main: { "agent-sandbox": entry("agent-sandbox", "agent") } },
    } as never;
    const result = overlayThreadSandboxMap({
      agentSandboxMap: agentMap,
      threadSandboxMap: threadMap,
      userId: "viewer",
      ownerId: "owner",
      branch,
    });
    expect(result?.viewer?.main?.["agent-sandbox"]?.sandboxHandle).toBe(
      "agent",
    );
    expect(result?.viewer?.[branch]?.["agent-sandbox"]?.sandboxHandle).toBe(
      "the-one",
    );
  });

  test("no entry for this branch → the agent's map, unchanged reference", () => {
    const agentMap = {
      viewer: { main: { "agent-sandbox": entry("agent-sandbox", "agent") } },
    } as never;
    expect(
      overlayThreadSandboxMap({
        agentSandboxMap: agentMap,
        threadSandboxMap: undefined,
        userId: "viewer",
        ownerId: "owner",
        branch,
      }),
    ).toBe(agentMap);
  });

  test("no userId / no branch → passthrough", () => {
    expect(
      overlayThreadSandboxMap({
        agentSandboxMap: undefined,
        threadSandboxMap: threadMap,
        userId: null,
        ownerId: "owner",
        branch,
      }),
    ).toBeUndefined();
  });
});

describe("deriveStartError", () => {
  const base = {
    mutationError: null,
    phase: null,
    startPending: false,
    // Default to exhausted so the failed-phase tests assert the terminal
    // surfacing; the not-exhausted (keep-booting) case is tested explicitly.
    claimRetryExhausted: true,
  } as const;

  test("no error, no failed phase → null (still booting)", () => {
    expect(deriveStartError(base)).toBeNull();
  });

  test("mutation rejection wins → surfaces the decoded error", () => {
    const mutationError = { code: null, message: "boom" };
    expect(deriveStartError({ ...base, mutationError })).toEqual(mutationError);
  });

  test("terminal claim-failed phase, retries exhausted → errored", () => {
    // Regression: a terminal claim failure arrives on the SSE lifecycle stream,
    // never as a SANDBOX_START rejection, so the preview used to spin on
    // "starting" forever. It must surface as a terminal error instead.
    expect(
      deriveStartError({
        ...base,
        phase: {
          kind: "failed",
          reason: "scheduling-timeout",
          message: "no capacity",
        },
      }),
    ).toEqual({ code: null, message: "no capacity" });
  });

  test("failed phase with auto-retry budget left → null (keep booting overlay)", () => {
    expect(
      deriveStartError({
        ...base,
        phase: {
          kind: "failed",
          reason: "scheduling-timeout",
          message: "no capacity",
        },
        claimRetryExhausted: false,
      }),
    ).toBeNull();
  });

  test("failed phase while a start is in flight → null (keep booting overlay)", () => {
    expect(
      deriveStartError({
        ...base,
        phase: { kind: "failed", reason: "unknown", message: "x" },
        startPending: true,
      }),
    ).toBeNull();
  });

  test("non-terminal phase (still provisioning) → null", () => {
    expect(
      deriveStartError({
        ...base,
        phase: { kind: "pulling-image", since: 0 },
      }),
    ).toBeNull();
  });

  test("ready phase → null", () => {
    expect(deriveStartError({ ...base, phase: { kind: "ready" } })).toBeNull();
  });
});

describe("isRetryableClaimFailure", () => {
  test("infra-transient reasons are retryable", () => {
    expect(isRetryableClaimFailure("scheduling-timeout")).toBe(true);
    expect(isRetryableClaimFailure("reconciler-error")).toBe(true);
    expect(isRetryableClaimFailure("claim-never-created")).toBe(true);
    expect(isRetryableClaimFailure("unknown")).toBe(true);
  });

  test("bad-image / crash-loop are NOT retryable (fail identically)", () => {
    expect(isRetryableClaimFailure("image-pull-backoff")).toBe(false);
    expect(isRetryableClaimFailure("crash-loop-backoff")).toBe(false);
  });
});

describe("shouldAutoRetryClaim", () => {
  const base = {
    executionEnabled: true,
    failedReason: "scheduling-timeout" as const,
    attempts: 0,
    isPending: false,
    userStopped: false,
    alreadyHandled: false,
  };

  test("retryable failure, budget left, not handled → true", () => {
    expect(shouldAutoRetryClaim(base)).toBe(true);
  });

  test("disabled execution boundary → false", () => {
    expect(shouldAutoRetryClaim({ ...base, executionEnabled: false })).toBe(
      false,
    );
  });

  test("not a failed phase (null reason) → false", () => {
    expect(shouldAutoRetryClaim({ ...base, failedReason: null })).toBe(false);
  });

  test("non-retryable reason → false", () => {
    expect(
      shouldAutoRetryClaim({ ...base, failedReason: "image-pull-backoff" }),
    ).toBe(false);
  });

  test("budget exhausted → false", () => {
    expect(
      shouldAutoRetryClaim({ ...base, attempts: MAX_CLAIM_AUTO_RETRIES }),
    ).toBe(false);
  });

  test("start already in flight → false", () => {
    expect(shouldAutoRetryClaim({ ...base, isPending: true })).toBe(false);
  });

  test("this episode already handled → false (fires once per episode)", () => {
    expect(shouldAutoRetryClaim({ ...base, alreadyHandled: true })).toBe(false);
  });

  test("user stopped → false", () => {
    expect(shouldAutoRetryClaim({ ...base, userStopped: true })).toBe(false);
  });
});

describe("reconcileClaimRetryEpisode", () => {
  test("same branch → returns the same reference (no reset)", () => {
    const prev = { branch: "main", count: 2, handled: true };
    expect(reconcileClaimRetryEpisode(prev, "main")).toBe(prev);
  });

  test("different branch → fresh budget", () => {
    // Regression: the lifecycle provider outlives a task switch, so a budget
    // exhausted by one branch's failed boot must not carry over and silently
    // skip auto-retry for a different branch's fresh boot.
    const prev = { branch: "main", count: 2, handled: true };
    expect(reconcileClaimRetryEpisode(prev, "feature-x")).toEqual({
      branch: "feature-x",
      count: 0,
      handled: false,
    });
  });

  test("null → a real branch resets too", () => {
    const prev = { branch: null, count: 1, handled: false };
    expect(reconcileClaimRetryEpisode(prev, "main")).toEqual({
      branch: "main",
      count: 0,
      handled: false,
    });
  });
});
