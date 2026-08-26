import { describe, expect, it } from "bun:test";
import { reviewerCommentGap } from "./reviewer-comment";

const THREAD = "thrd_qa";

describe("reviewerCommentGap", () => {
  it("flags a reviewer that posted nothing", () => {
    expect(reviewerCommentGap([], THREAD, "code_review")).toBe("missing");
  });

  it("does not credit another run's comment", () => {
    const comments = [{ threadId: "thrd_other", body: "looks good" }];
    expect(reviewerCommentGap(comments, THREAD, "code_review")).toBe("missing");
    // ...nor a human's.
    expect(
      reviewerCommentGap([{ threadId: null, body: "ok" }], THREAD, "qa"),
    ).toBe("missing");
  });

  it("accepts a code review comment with no images", () => {
    const comments = [{ threadId: THREAD, body: "read the diff, all good" }];
    expect(reviewerCommentGap(comments, THREAD, "code_review")).toBeNull();
  });

  it("requires QA to show the visual change", () => {
    const comments = [{ threadId: THREAD, body: "checked the flow, passes" }];
    expect(reviewerCommentGap(comments, THREAD, "qa")).toBe("no_screenshots");
  });

  it("accepts QA with an embedded screenshot", () => {
    const comments = [
      {
        threadId: THREAD,
        body: "| ![before](/api/o/fs/outputs/read?path=a) |",
      },
    ];
    expect(reviewerCommentGap(comments, THREAD, "qa")).toBeNull();
  });

  it("accepts QA that justifies the absence", () => {
    for (const body of [
      "No visual changes — migration only.",
      "This is a non-visual change (config).",
      "Not a visual change; backend only.",
    ]) {
      expect(
        reviewerCommentGap([{ threadId: THREAD, body }], THREAD, "qa"),
      ).toBeNull();
    }
  });
});
