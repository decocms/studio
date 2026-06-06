import { describe, expect, it } from "bun:test";
import {
  buildConsumerName,
  buildWorkSubject,
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
  it("accepts a valid work item (no sandbox / orgSlug)", () => {
    const item = {
      runId: "run_01",
      threadId: "thrd_01",
      orgId: "org_01",
      userId: "usr_01",
      runFenceToken: "tok-abc",
      harnessInput: { threadId: "thrd_01" },
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
});
