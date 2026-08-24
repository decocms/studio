import { describe, expect, test } from "bun:test";
import { smartReviewVerdictQueryKey } from "./use-smart-review-verdict.ts";

const BASE = {
  orgSlug: "acme",
  virtualMcpId: "site",
  branch: "feature",
  threadId: "coding-thread" as string | null,
  signature: "diff-signature",
  language: "en",
};

describe("smartReviewVerdictQueryKey", () => {
  test("isolates verdicts by thread", () => {
    expect(
      smartReviewVerdictQueryKey({ ...BASE, threadId: "coding-thread" }),
    ).not.toEqual(
      smartReviewVerdictQueryKey({ ...BASE, threadId: "cms-thread" }),
    );
  });

  test("isolates local sandbox verdicts from Fast Preview authority", () => {
    expect(smartReviewVerdictQueryKey(BASE)).not.toEqual(
      smartReviewVerdictQueryKey({ ...BASE, fastPreview: true }),
    );
  });
});
