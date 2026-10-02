import { describe, expect, it } from "bun:test";
import { orphanedCommentAttachments } from "./comment-attachments";

// Names as the composer writes them: a fresh UUID plus the file's extension.
const A = "0b7c2f8e-3d1a-4c5b-9e6f-1a2b3c4d5e6f.png";
const B = "5f1e9a2b-7c3d-4e8f-a1b2-c3d4e5f6a7b8.pdf";
const read = (path: string) =>
  `/api/acme/fs/uploads/read?path=${encodeURIComponent(path)}`;

describe("orphanedCommentAttachments", () => {
  it("returns the removed comments' attachments nothing kept still links to", () => {
    const removed = [
      `![shot](${read(`task-comments/tbi_1/${A}`)})`,
      `[spec.pdf](${read(`task-comments/tbi_1/${B}`)})`,
    ];
    // A surviving comment quotes the screenshot, so it has to stay.
    const kept = [
      `same as before: ![shot](${read(`task-comments/tbi_1/${A}`)})`,
    ];

    expect(
      orphanedCommentAttachments({ taskId: "tbi_1", removed, kept }),
    ).toEqual([`task-comments/tbi_1/${B}`]);
  });

  it("keeps a file that something kept links to in any form", () => {
    const removed = [
      `![a](${read(`task-comments/tbi_1/${A}`)})`,
      `![b](${read(`task-comments/tbi_1/${B}`)})`,
    ];
    const kept = [
      // A full URL copied from the browser into the description.
      `https://studio.example.com${read(`task-comments/tbi_1/${A}`)}`,
      // A bare URL in prose.
      `look at ${read(`task-comments/tbi_1/${B}`)}`,
    ];

    expect(
      orphanedCommentAttachments({ taskId: "tbi_1", removed, kept }),
    ).toEqual([]);
  });

  it("returns nothing when the removed comments carried no attachments", () => {
    expect(
      orphanedCommentAttachments({
        taskId: "tbi_1",
        removed: ["just text"],
        kept: [],
      }),
    ).toEqual([]);
  });
});
