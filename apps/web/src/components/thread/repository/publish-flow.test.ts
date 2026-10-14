import { afterEach, describe, expect, it } from "bun:test";
import {
  describePublishFailure,
  publishMessageParts,
  publishNoteParts,
  PublishStepError,
  runSubmitForReviewFlow,
  type PublishTarget,
} from "./publish-flow.ts";
import {
  reviewDiffSignature,
  type GitDiffResult,
  type GitStatus,
} from "./sandbox-git-api.ts";

const FALLBACK = "Changes from feature-branch";

/** Stands in for the real `t`: renders the key plus its interpolations. */
const t = ((key: string, vars?: Record<string, unknown>) =>
  vars
    ? `${key}(${Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key) as never;

const PR = { number: 42, htmlUrl: "https://github.com/o/r/pull/42" };

describe("publishMessageParts", () => {
  it("uses the fallback title when the author left the title empty", () => {
    expect(
      publishMessageParts({ title: "  ", body: "", fallbackTitle: FALLBACK }),
    ).toEqual({ title: FALLBACK, body: undefined, message: FALLBACK });
  });

  it("keeps the commit message to the body when only a body was written", () => {
    expect(
      publishMessageParts({
        title: "",
        body: "why it changed",
        fallbackTitle: FALLBACK,
      }),
    ).toEqual({
      title: FALLBACK,
      body: "why it changed",
      message: "why it changed",
    });
  });

  it("joins title and body into the commit message", () => {
    expect(
      publishMessageParts({
        title: " Update pricing ",
        body: " new tiers ",
        fallbackTitle: FALLBACK,
      }),
    ).toEqual({
      title: "Update pricing",
      body: "new tiers",
      message: "Update pricing\n\nnew tiers",
    });
  });
});

describe("publishNoteParts", () => {
  it("titles the change with the note's first line", () => {
    expect(publishNoteParts("Update pricing", FALLBACK)).toEqual({
      title: "Update pricing",
      body: undefined,
      message: "Update pricing",
    });
  });

  it("puts every line after the first into the body", () => {
    expect(
      publishNoteParts("Update pricing\nnew tiers\nand a banner", FALLBACK),
    ).toEqual({
      title: "Update pricing",
      body: "new tiers\nand a banner",
      message: "Update pricing\n\nnew tiers\nand a banner",
    });
  });

  it("falls back to the branch title for a blank note", () => {
    expect(publishNoteParts("   \n  ", FALLBACK)).toEqual({
      title: FALLBACK,
      body: undefined,
      message: FALLBACK,
    });
  });
});

describe("describePublishFailure", () => {
  it("names the pull request a failed merge left behind", () => {
    const failure = describePublishFailure(
      new PublishStepError("merge conflict", "merge", PR),
      t,
    );
    expect(failure.pullRequest).toEqual(PR);
    expect(failure.message).toBe(
      "thread.publishDialog.mergeFailed(prNumber=42,message=merge conflict)",
    );
  });

  it("reports no pull request when an earlier step failed", () => {
    expect(
      describePublishFailure(new PublishStepError("push denied", "push"), t),
    ).toEqual({ message: "push denied", pullRequest: null, headMoved: false });
  });

  it("reports no pull request when the merge failed before one opened", () => {
    expect(
      describePublishFailure(new PublishStepError("merge blew up", "merge"), t),
    ).toEqual({
      message: "merge blew up",
      pullRequest: null,
      headMoved: false,
    });
  });

  it("passes a plain error's message through", () => {
    expect(describePublishFailure(new Error("offline"), t)).toEqual({
      message: "offline",
      pullRequest: null,
      headMoved: false,
    });
  });

  it("falls back to the generic message for a non-Error throw", () => {
    expect(describePublishFailure("boom", t)).toEqual({
      message: "thread.publishDialog.failedPublish",
      pullRequest: null,
      headMoved: false,
    });
  });
});

describe("a sandbox publish re-checks the changes it showed", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const status: GitStatus = {
    not_added: [],
    conflicted: [],
    created: [],
    deleted: [],
    modified: ["src/a.tsx"],
    renamed: [],
    files: [{ path: "src/a.tsx", index: " ", working_dir: "M" }],
    staged: [],
    ahead: 0,
    behind: 0,
    current: "feat",
    tracking: "origin/feat",
    detached: false,
    aheadOfBase: 0,
    headSha: "a".repeat(40),
  };
  const shown: GitDiffResult = {
    diffs: { "src/a.tsx": { from: "old", to: "reviewed" } },
  };
  const target = (diff: GitDiffResult): PublishTarget => ({
    orgSlug: "org",
    virtualMcpId: "vm",
    branch: "feat",
    threadId: null,
    baseBranch: "main",
    target: {} as never,
    owner: "o",
    repo: "r",
    headBranch: "feat",
    expectedHeadSha: status.headSha,
    expectedDiffSignature: reviewDiffSignature(diff),
  });

  /** Serves `status`, the working tree as `live`, and records publish calls. */
  function serve(live: GitDiffResult) {
    const published: string[] = [];
    globalThis.fetch = ((url: string) => {
      if (url.includes("/git/status")) {
        return Promise.resolve(Response.json(status));
      }
      if (url.includes("/git/diff"))
        return Promise.resolve(Response.json(live));
      published.push(url);
      return Promise.resolve(Response.json({ error: "stop" }, { status: 500 }));
    }) as unknown as typeof fetch;
    return published;
  }

  it("stops before pushing when the working tree changed under the same head", async () => {
    const published = serve({
      diffs: { "src/a.tsx": { from: "old", to: "edited after review" } },
    });

    const error = await runSubmitForReviewFlow(target(shown), {
      title: "t",
      message: "t",
    }).catch((e: unknown) => e);

    expect(describePublishFailure(error, t).headMoved).toBe(true);
    expect(published).toEqual([]);
  });

  it("pushes when the working tree still matches what was shown", async () => {
    const published = serve(shown);

    await runSubmitForReviewFlow(target(shown), {
      title: "t",
      message: "t",
    }).catch(() => null);

    expect(published.some((url) => url.includes("/git/publish"))).toBe(true);
  });
});
