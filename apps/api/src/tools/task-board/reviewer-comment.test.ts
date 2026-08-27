import { describe, expect, it } from "bun:test";
import { NO_VISUAL_SURFACE } from "@decocms/shared/task-board";
import {
  nextGapAfterMirror,
  reviewerCommentGap,
  verdictCommentBody,
} from "./reviewer-comment";

const THREAD = "thrd_qa";
/** Long enough to clear the progress-note floor. */
const RECORD =
  "Checked the acceptance criteria on the preview: create passes, edit passes, delete passes.";

describe("reviewerCommentGap", () => {
  it("flags a reviewer that posted nothing", () => {
    expect(reviewerCommentGap([], THREAD, "code_review")).toBe("missing");
  });

  it("does not credit another run's comment", () => {
    const comments = [{ threadId: "thrd_other", body: RECORD }];
    expect(reviewerCommentGap(comments, THREAD, "code_review")).toBe("missing");
    // ...nor a human's.
    expect(
      reviewerCommentGap([{ threadId: null, body: RECORD }], THREAD, "qa"),
    ).toBe("missing");
  });

  it("does not credit a progress note", () => {
    const comments = [{ threadId: THREAD, body: "starting review" }];
    expect(reviewerCommentGap(comments, THREAD, "code_review")).toBe("missing");
  });

  it("accepts a code review comment with no images", () => {
    const comments = [{ threadId: THREAD, body: RECORD }];
    expect(reviewerCommentGap(comments, THREAD, "code_review")).toBeNull();
  });

  it("requires QA to show the visual change", () => {
    const comments = [{ threadId: THREAD, body: RECORD }];
    expect(reviewerCommentGap(comments, THREAD, "qa")).toBe("no_screenshots");
  });

  it("does not take a claim about visuals for evidence of them", () => {
    // What a UI run that forgot its screenshots writes.
    for (const tail of [
      "No visual regressions.",
      "Found no visual differences between before and after.",
      "No obvious visual issues.",
    ]) {
      expect(
        reviewerCommentGap(
          [{ threadId: THREAD, body: `${RECORD} ${tail}` }],
          THREAD,
          "qa",
        ),
      ).toBe("no_screenshots");
    }
  });

  it("accepts QA with an embedded screenshot", () => {
    const comments = [
      {
        threadId: THREAD,
        body: `${RECORD}\n| ![before](/api/o/fs/outputs/read?path=a) |`,
      },
    ];
    expect(reviewerCommentGap(comments, THREAD, "qa")).toBeNull();
  });

  it("accepts QA that declares the change free of visual surface", () => {
    const body = `${RECORD}\n${NO_VISUAL_SURFACE} — migration only.`;
    expect(
      reviewerCommentGap([{ threadId: THREAD, body }], THREAD, "qa"),
    ).toBeNull();
  });
});

describe("nextGapAfterMirror", () => {
  it("accepts a short-but-real mirrored code-review verdict", () => {
    // A one-word verdict mirrors under the progress-note floor.
    expect(
      nextGapAfterMirror(
        "code_review",
        verdictCommentBody("code_review", "approve", "LGTM"),
      ),
    ).toBeNull();
  });

  it("still asks QA for screenshots when the mirrored notes are prose only", () => {
    expect(
      nextGapAfterMirror("qa", verdictCommentBody("qa", "approve", RECORD)),
    ).toBe("no_screenshots");
  });

  it("accepts a mirrored QA verdict that already embeds a screenshot", () => {
    const body = verdictCommentBody("qa", "approve", `${RECORD}\n![before](x)`);
    expect(nextGapAfterMirror("qa", body)).toBeNull();
  });
});

describe("verdictCommentBody", () => {
  it("heads the reviewer's own notes with who said what", () => {
    // The Code Reviewer's ~2,000-character review lives in the verdict notes,
    // where the timeline truncates it to one line; this is what gets mirrored
    // into the comment feed instead of paying for a second run to retype it.
    expect(verdictCommentBody("code_review", "approve", "  LGTM\n")).toBe(
      "**Code Reviewer** approved:\n\nLGTM",
    );
    expect(verdictCommentBody("qa", "request_changes", "preview 503s")).toBe(
      "**QA Agent** requested changes:\n\npreview 503s",
    );
  });
});
