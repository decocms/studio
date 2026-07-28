import { describe, expect, it } from "bun:test";
import { delay } from "@decocms/shared/std";
import {
  readBoundedText,
  UpstreamPayloadTooLargeError,
} from "../../lib/bounded-text";
import {
  assertSandboxBranchParam,
  redactRepoDir,
  withClaimGitLock,
} from "./sandbox-proxy";

describe("redactRepoDir", () => {
  it("nulls a container-internal repoDir while preserving other fields", () => {
    const input = JSON.stringify({
      bootId: "boot-1",
      ready: true,
      repoDir: "/app/repo",
    });
    const out = JSON.parse(redactRepoDir(input));
    expect(out).toEqual({ bootId: "boot-1", ready: true, repoDir: null });
  });

  it("nulls repoDir even when it is already null (no-op semantics)", () => {
    const out = JSON.parse(redactRepoDir(JSON.stringify({ repoDir: null })));
    expect(out.repoDir).toBeNull();
  });

  it("leaves a payload without a repoDir key untouched", () => {
    const input = JSON.stringify({ bootId: "boot-1", ready: false });
    expect(redactRepoDir(input)).toBe(input);
  });

  it("passes through non-JSON bodies unchanged", () => {
    expect(redactRepoDir("not json")).toBe("not json");
    expect(redactRepoDir("")).toBe("");
  });

  it("passes through JSON that is not an object", () => {
    expect(redactRepoDir("[1,2,3]")).toBe("[1,2,3]");
    expect(redactRepoDir('"repoDir"')).toBe('"repoDir"');
  });
});

describe("assertSandboxBranchParam", () => {
  it("accepts a plain branch name", () => {
    expect(() => assertSandboxBranchParam("main")).not.toThrow();
    expect(() => assertSandboxBranchParam("feature/foo-bar_123")).not.toThrow();
  });

  it("accepts a thread: synthetic branch id", () => {
    expect(() => assertSandboxBranchParam("thread:abc123")).not.toThrow();
  });

  it("rejects an empty branch", () => {
    expect(() => assertSandboxBranchParam("")).toThrow();
  });

  it("rejects a thread: branch with no id after the prefix", () => {
    expect(() => assertSandboxBranchParam("thread:")).toThrow();
  });

  it("rejects path traversal via ..", () => {
    expect(() => assertSandboxBranchParam("a/../b")).toThrow();
    expect(() => assertSandboxBranchParam("thread:../etc")).toThrow();
  });

  it("rejects a leading or trailing slash", () => {
    expect(() => assertSandboxBranchParam("/leading")).toThrow();
    expect(() => assertSandboxBranchParam("trailing/")).toThrow();
  });

  it("rejects a git lock-file ref", () => {
    expect(() => assertSandboxBranchParam("refs/heads/main.lock")).toThrow();
  });

  it("rejects a branch name over 255 chars", () => {
    expect(() => assertSandboxBranchParam("a".repeat(256))).toThrow();
  });

  it("rejects characters outside the git-ref charset", () => {
    expect(() => assertSandboxBranchParam("has space")).toThrow();
    expect(() => assertSandboxBranchParam("a:b")).toThrow();
    expect(() => assertSandboxBranchParam("-leading-dash")).toThrow();
  });
});

describe("readBoundedText", () => {
  it("returns the full body when under the cap", async () => {
    const res = new Response("hello world");
    expect(await readBoundedText(res, 1024)).toBe("hello world");
  });

  it("throws instead of buffering a body over the cap", async () => {
    const res = new Response("x".repeat(100));
    await expect(readBoundedText(res, 10)).rejects.toThrow(
      UpstreamPayloadTooLargeError,
    );
  });
});

describe("withClaimGitLock", () => {
  it("serializes concurrent calls for the same claim", async () => {
    const order: string[] = [];
    const first = withClaimGitLock("claim-1", async () => {
      order.push("first-start");
      await delay(5);
      order.push("first-end");
    });
    const second = withClaimGitLock("claim-1", async () => {
      order.push("second-start");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("does not serialize calls for different claims", async () => {
    let firstDone = false;
    let secondSawFirstDone: boolean | undefined;
    const first = withClaimGitLock("claim-a", async () => {
      await delay(5);
      firstDone = true;
    });
    const second = withClaimGitLock("claim-b", async () => {
      secondSawFirstDone = firstDone;
    });
    await Promise.all([first, second]);
    expect(secondSawFirstDone).toBe(false);
  });

  it("does not let a rejection block later calls for the same claim", async () => {
    await expect(
      withClaimGitLock("claim-err", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = await withClaimGitLock("claim-err", async () => "ok");
    expect(after).toBe("ok");
  });
});
