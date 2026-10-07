import { describe, expect, it } from "bun:test";
import { NO_VISUAL_SURFACE } from "@decocms/shared/task-board";
import {
  nextGapAfterMirror,
  reviewerCommentGap,
  verdictCommentBody,
  verdictMirrorAudience,
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
    const comments = [
      { threadId: "thrd_other", audience: "internal" as const, body: RECORD },
    ];
    expect(reviewerCommentGap(comments, THREAD)).toBe("missing");
    // ...nor a human's.
    expect(
      reviewerCommentGap(
        [{ threadId: null, audience: "human" as const, body: RECORD }],
        THREAD,
      ),
    ).toBe("missing");
  });

  it("does not credit a progress note", () => {
    const comments = [
      {
        threadId: THREAD,
        audience: "internal" as const,
        body: "starting review",
      },
    ];
    expect(reviewerCommentGap(comments, THREAD)).toBe("missing");
  });

  // Inverted with the merged reviewer: a code-only record used to be complete,
  // because a separate QA run owed the screenshots. The one reviewer owes both,
  // so prose alone is now a gap — the sentinel is how a backend-only change says
  // there was nothing to show.
  it("requires the visual change even from a code-only record", () => {
    const comments = [
      { threadId: THREAD, audience: "internal" as const, body: RECORD },
    ];
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
          [
            {
              threadId: THREAD,
              audience: "human" as const,
              body: `${RECORD} ${tail}`,
            },
          ],
          THREAD,
        ),
      ).toBe("no_screenshots");
    }
  });

  it("accepts screenshots in a comment for the person reviewing the task", () => {
    const comments = [
      { threadId: THREAD, audience: "internal" as const, body: RECORD },
      {
        threadId: THREAD,
        audience: "human" as const,
        body: "Approved.\n| ![before](/api/o/fs/outputs/read?path=a) |",
      },
    ];
    expect(reviewerCommentGap(comments, THREAD)).toBeNull();
  });

  it("does not count screenshots only the agents see", () => {
    const comments = [
      {
        threadId: THREAD,
        audience: "internal" as const,
        body: `${RECORD}\n| ![before](/api/o/fs/outputs/read?path=a) |`,
      },
    ];
    expect(reviewerCommentGap(comments, THREAD)).toBe("no_screenshots");
  });

  it("accepts a record that declares the change free of visual surface", () => {
    const body = `${RECORD}\n${NO_VISUAL_SURFACE} — migration only.`;
    expect(
      reviewerCommentGap(
        [{ threadId: THREAD, audience: "internal", body }],
        THREAD,
      ),
    ).toBeNull();
  });
});

describe("nextGapAfterMirror", () => {
  const internal = (body: string) => ({ audience: "internal" as const, body });

  it("asks for screenshots when the mirrored notes are prose only", () => {
    // Not "missing": a one-word verdict mirrors under the progress-note floor,
    // and the mirrored text IS the reviewer's record however short.
    for (const notes of ["LGTM", RECORD]) {
      expect(
        nextGapAfterMirror(
          [],
          THREAD,
          internal(verdictCommentBody("reviewer", "approve", notes)),
        ),
      ).toBe("no_screenshots");
    }
  });

  it("counts a screenshot in the mirror only when a person sees it", () => {
    const body = verdictCommentBody(
      "reviewer",
      "request_changes",
      `${RECORD}\n![before](x)`,
    );
    expect(nextGapAfterMirror([], THREAD, internal(body))).toBe(
      "no_screenshots",
    );
    expect(
      nextGapAfterMirror([], THREAD, { audience: "human", body }),
    ).toBeNull();
  });

  it("accepts the sentinel in the mirror, or screenshots the run already showed", () => {
    const sentinel = verdictCommentBody(
      "reviewer",
      "approve",
      `${NO_VISUAL_SURFACE} — config only.`,
    );
    expect(nextGapAfterMirror([], THREAD, internal(sentinel))).toBeNull();
    const shown = [
      { threadId: THREAD, audience: "human" as const, body: "![after](x)" },
    ];
    expect(
      nextGapAfterMirror(
        shown,
        THREAD,
        internal(verdictCommentBody("reviewer", "approve", "LGTM")),
      ),
    ).toBeNull();
  });
});

describe("verdictMirrorAudience", () => {
  const record = {
    threadId: THREAD,
    audience: "internal" as const,
    body: `${RECORD}\n${NO_VISUAL_SURFACE} — backend only.`,
  };
  const note = {
    threadId: THREAD,
    audience: "human" as const,
    body: "The checkout needs a product decision on the discount rule.",
  };

  it("shows a change request's notes to the person the run never told", () => {
    expect(
      verdictMirrorAudience([record], THREAD, "request_changes", null),
    ).toBe("human");
    // Even with no record at all: one comment serves both.
    expect(
      verdictMirrorAudience([], THREAD, "request_changes", "missing"),
    ).toBe("human");
    // A note from another run is not this reviewer telling them.
    expect(
      verdictMirrorAudience(
        [record, { ...note, threadId: "thrd_super" }],
        THREAD,
        "request_changes",
        null,
      ),
    ).toBe("human");
  });

  it("mirrors nothing for a change request the run already explained", () => {
    expect(
      verdictMirrorAudience([record, note], THREAD, "request_changes", null),
    ).toBeNull();
  });

  it("keeps an approval quiet unless the record is missing", () => {
    expect(verdictMirrorAudience([record], THREAD, "approve", null)).toBeNull();
    expect(verdictMirrorAudience([], THREAD, "approve", "missing")).toBe(
      "internal",
    );
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
