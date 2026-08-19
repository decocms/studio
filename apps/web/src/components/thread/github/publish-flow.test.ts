import { describe, expect, it } from "bun:test";
import {
  describePublishFailure,
  publishMessageParts,
  publishNoteParts,
  PublishStepError,
} from "./publish-flow.ts";

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
    ).toEqual({ message: "push denied", pullRequest: null });
  });

  it("reports no pull request when the merge failed before one opened", () => {
    expect(
      describePublishFailure(new PublishStepError("merge blew up", "merge"), t),
    ).toEqual({ message: "merge blew up", pullRequest: null });
  });

  it("passes a plain error's message through", () => {
    expect(describePublishFailure(new Error("offline"), t)).toEqual({
      message: "offline",
      pullRequest: null,
    });
  });

  it("falls back to the generic message for a non-Error throw", () => {
    expect(describePublishFailure("boom", t)).toEqual({
      message: "thread.publishDialog.failedPublish",
      pullRequest: null,
    });
  });
});
