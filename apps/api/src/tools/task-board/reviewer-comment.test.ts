import { describe, expect, it } from "bun:test";
import { NO_VISUAL_SURFACE } from "@decocms/shared/task-board";
import {
  nextGapAfterMirror,
  reviewerCommentGap,
  verdictCommentBody,
} from "./reviewer-comment";

const THREAD = "thrd_reviewer";
/** Long enough to clear the progress-note floor. */
const RECORD =
  "Checked the acceptance criteria on the preview: create passes, edit passes, delete passes.";

describe("reviewerCommentGap", () => {
  it("flags a reviewer that posted nothing", () => {
    expect(reviewerCommentGap([], THREAD)).toBe("missing");
  });

  it("does not credit another run's comment", () => {
    const comments = [{ threadId: "thrd_other", body: RECORD }];
    expect(reviewerCommentGap(comments, THREAD)).toBe("missing");
    // ...nor a human's.
    expect(reviewerCommentGap([{ threadId: null, body: RECORD }], THREAD)).toBe(
      "missing",
    );
  });

  it("does not credit a progress note", () => {
    const comments = [{ threadId: THREAD, body: "starting review" }];
    expect(reviewerCommentGap(comments, THREAD)).toBe("missing");
  });

  // Inverted with the merged reviewer: a code-only record used to be complete,
  // because a separate QA run owed the screenshots. The one reviewer owes both,
  // so prose alone is now a gap — the sentinel is how a backend-only change says
  // there was nothing to show.
  it("requires the visual change even from a code-only record", () => {
    const comments = [{ threadId: THREAD, body: RECORD }];
    expect(reviewerCommentGap(comments, THREAD)).toBe("no_screenshots");
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
        ),
      ).toBe("no_screenshots");
    }
  });

  it("accepts a record with an embedded screenshot", () => {
    const comments = [
      {
        threadId: THREAD,
        body: `${RECORD}\n| ![before](/api/o/fs/outputs/read?path=a) |`,
      },
    ];
    expect(reviewerCommentGap(comments, THREAD)).toBeNull();
  });

  it("accepts a record that declares the change free of visual surface", () => {
    const body = `${RECORD}\n${NO_VISUAL_SURFACE} — migration only.`;
    expect(reviewerCommentGap([{ threadId: THREAD, body }], THREAD)).toBeNull();
  });
});

describe("nextGapAfterMirror", () => {
  it("asks for screenshots when the mirrored notes are prose only", () => {
    // Not "missing": a one-word verdict mirrors under the progress-note floor,
    // and the mirrored text IS the reviewer's record however short.
    expect(
      nextGapAfterMirror(verdictCommentBody("reviewer", "approve", "LGTM")),
    ).toBe("no_screenshots");
    expect(
      nextGapAfterMirror(verdictCommentBody("reviewer", "approve", RECORD)),
    ).toBe("no_screenshots");
  });

  it("accepts a mirrored verdict that already embeds a screenshot", () => {
    const body = verdictCommentBody(
      "reviewer",
      "approve",
      `${RECORD}\n![before](x)`,
    );
    expect(nextGapAfterMirror(body)).toBeNull();
  });
});

describe("verdictCommentBody", () => {
  it("heads the reviewer's own notes with who said what", () => {
    // A ~2,000-character review lives in the verdict notes, where the timeline
    // truncates it to one line; this is what gets mirrored into the comment feed
    // instead of paying for a second run to retype it.
    expect(verdictCommentBody("reviewer", "approve", "  LGTM\n")).toBe(
      "**Reviewer** approved:\n\nLGTM",
    );
    expect(
      verdictCommentBody("reviewer", "request_changes", "preview 503s"),
    ).toBe("**Reviewer** requested changes:\n\npreview 503s");
  });
});
