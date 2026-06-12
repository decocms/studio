import { describe, expect, it } from "bun:test";
import {
  buildConsumerName,
  buildWorkSubject,
  LinkWorkQueue,
  type WorkItem,
  workItemDedupKey,
  workItemSchema,
} from "./link-work-queue";

describe("buildWorkSubject", () => {
  it("produces a valid NATS subject token from a userSub", () => {
    const subj = buildWorkSubject("user_abc123");
    expect(subj).toBe("link.work.user_abc123");
  });

  it("rejects a userSub containing a NATS wildcard", () => {
    expect(() => buildWorkSubject("user.bad")).toThrow(
      "Invalid NATS subject token",
    );
    expect(() => buildWorkSubject("user*bad")).toThrow(
      "Invalid NATS subject token",
    );
  });
});

describe("buildConsumerName", () => {
  it("produces the expected consumer name prefix", () => {
    expect(buildConsumerName("user_abc")).toBe("link-work-user_abc");
  });
});

describe("workItemSchema", () => {
  it("accepts a valid work item (no sandbox)", () => {
    const item = {
      runId: "run_01",
      threadId: "thrd_01",
      orgId: "org_01",
      userId: "usr_01",
      runFenceToken: "tok-abc",
      harnessInput: { threadId: "thrd_01" },
      orgSlug: "test-org",
    };
    const parsed = workItemSchema.safeParse(item);
    expect(parsed.success).toBe(true);
  });

  it("accepts a work item with full sandbox config and orgSlug", () => {
    const item = {
      runId: "run_02",
      threadId: "thrd_02",
      orgId: "org_02",
      userId: "usr_02",
      runFenceToken: "tok-def",
      harnessInput: { threadId: "thrd_02" },
      sandbox: {
        handle: "agent-vm-abc-deco/my-branch",
        repo: {
          cloneUrl: "https://x-access-token:ghp_xxx@github.com/owner/repo.git",
          branch: "deco/my-branch",
          userName: "Alice",
          userEmail: "alice@example.com",
        },
        workload: {
          runtime: "bun" as const,
          packageManager: "bun" as const,
        },
        offloadAllowedHosts: ["s3.us-east-1.amazonaws.com"],
        offloadAllowSameHostDev: false,
      },
      orgSlug: "my-org",
    };
    const parsed = workItemSchema.safeParse(item);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.sandbox?.handle).toBe("agent-vm-abc-deco/my-branch");
    expect(parsed.data.sandbox?.repo?.cloneUrl).toContain("ghp_xxx");
    expect(parsed.data.sandbox?.workload?.runtime).toBe("bun");
    expect(parsed.data.orgSlug).toBe("my-org");
  });

  it("accepts a work item with sandbox handle only (no repo/workload)", () => {
    const item = {
      runId: "run_03",
      threadId: "thrd_03",
      orgId: "org_03",
      userId: "usr_03",
      runFenceToken: "tok-ghi",
      harnessInput: { threadId: "thrd_03" },
      sandbox: { handle: "agent-vm-xyz" },
      orgSlug: "test-org",
    };
    const parsed = workItemSchema.safeParse(item);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.sandbox?.handle).toBe("agent-vm-xyz");
    expect(parsed.data.sandbox?.repo).toBeUndefined();
    expect(parsed.data.sandbox?.workload).toBeUndefined();
  });

  it("rejects a sandbox with an invalid runtime", () => {
    const item = {
      runId: "run_04",
      threadId: "thrd_04",
      orgId: "org_04",
      userId: "usr_04",
      runFenceToken: "tok-jkl",
      harnessInput: {},
      sandbox: {
        handle: "agent-vm",
        workload: { runtime: "ruby", packageManager: "bundler" },
      },
    };
    const parsed = workItemSchema.safeParse(item);
    expect(parsed.success).toBe(false);
  });

  it("rejects a work item missing required fields", () => {
    const parsed = workItemSchema.safeParse({ runId: "r1" });
    expect(parsed.success).toBe(false);
  });

  it("accepts a work item with messagesRef (offloaded messages)", () => {
    const item = {
      runId: "run_05",
      threadId: "thrd_05",
      orgId: "org_05",
      userId: "usr_05",
      runFenceToken: "tok-mno",
      harnessInput: { threadId: "thrd_05", messages: [] },
      orgSlug: "test-org",
      messagesRef: {
        url: "https://s3.example.com/link-dispatch/abc123?X-Amz-Signature=sig",
        bytes: 123456,
        sha256:
          "deadbeef01234567deadbeef01234567deadbeef01234567deadbeef01234567",
      },
    };
    const parsed = workItemSchema.safeParse(item);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.messagesRef?.url).toContain("s3.example.com");
    expect(parsed.data.messagesRef?.bytes).toBe(123456);
    expect(parsed.data.messagesRef?.sha256).toHaveLength(64);
  });

  it("accepts a work item without messagesRef (no offload needed)", () => {
    const item = {
      runId: "run_06",
      threadId: "thrd_06",
      orgId: "org_06",
      userId: "usr_06",
      runFenceToken: "tok-pqr",
      harnessInput: { threadId: "thrd_06" },
      orgSlug: "test-org",
    };
    const parsed = workItemSchema.safeParse(item);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.messagesRef).toBeUndefined();
  });

  it("rejects a work item missing orgSlug", () => {
    const item = {
      runId: "run_07",
      threadId: "thrd_07",
      orgId: "org_07",
      userId: "usr_07",
      runFenceToken: "tok-stu",
      harnessInput: { threadId: "thrd_07" },
    };
    expect(workItemSchema.safeParse(item).success).toBe(false);
  });
});

describe("workItemDedupKey", () => {
  // Regression: harness-conformance "claude-code session id round-trips" drove
  // two turns on one thread; the second never enqueued because the publish
  // deduped on `runId` (== threadId), colliding with turn 1 in NATS's
  // duplicate window. The dedup key must be the per-attempt fence token.
  it("is the per-attempt fence token, NOT the thread-scoped runId", () => {
    const base: Omit<WorkItem, "runFenceToken"> = {
      runId: "thrd_same", // runId aliases the threadId — identical across turns
      threadId: "thrd_same",
      orgId: "org_01",
      userId: "usr_01",
      harnessInput: {},
      orgSlug: "test-org",
    };
    const turn1: WorkItem = { ...base, runFenceToken: "fence-turn-1" };
    const turn2: WorkItem = { ...base, runFenceToken: "fence-turn-2" };

    // Same thread/run id, distinct attempts → distinct dedup keys, so turn 2's
    // publish is NOT swallowed by NATS dedup.
    expect(workItemDedupKey(turn1)).toBe("fence-turn-1");
    expect(workItemDedupKey(turn1)).not.toBe(workItemDedupKey(turn2));
    expect(workItemDedupKey(turn1)).not.toBe(turn1.runId);
  });
});

describe("LinkWorkQueue stream config", () => {
  it("stream config includes max_age of 1h (3600 * 1e9 nanoseconds)", async () => {
    // Capture the config passed to jsm.streams.add by stubbing JetStreamManager.
    let capturedConfig: Record<string, unknown> | null = null;

    const jsmStub = {
      streams: {
        info: async (_name: string) => {
          // Simulate stream not found so add() is called.
          throw new Error("stream not found");
        },
        add: async (config: Record<string, unknown>) => {
          capturedConfig = config;
        },
        update: async (_name: string, _config: unknown) => {},
      },
    };

    const queue = new LinkWorkQueue({
      getJetStreamManager: async () =>
        jsmStub as unknown as import("nats").JetStreamManager,
      getJetStream: () => null,
    });

    await queue.init();

    expect(capturedConfig).not.toBeNull();
    // 1h in nanoseconds
    expect(capturedConfig!["max_age"]).toBe(3_600 * 1_000_000_000);
  });
});
