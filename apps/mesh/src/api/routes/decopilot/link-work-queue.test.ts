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
  it("accepts a valid work item", () => {
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

  it("rejects a work item missing required fields", () => {
    const parsed = workItemSchema.safeParse({ runId: "r1" });
    expect(parsed.success).toBe(false);
  });
});
