import { describe, expect, it } from "bun:test";
import { orphanedCommentAttachments } from "./comment-attachments";

const read = (path: string) =>
  `/api/acme/fs/uploads/read?path=${encodeURIComponent(path)}`;

describe("orphanedCommentAttachments", () => {
  it("returns the removed comments' attachments nothing kept still links to", () => {
    const removed = [
      `![shot](${read("task-comments/tbi_1/a1.png")})`,
      `[spec.pdf](${read("task-comments/tbi_1/b2.pdf")})`,
    ];
    // A surviving comment quotes the screenshot, so it has to stay.
    const kept = [
      `same as before: ![shot](${read("task-comments/tbi_1/a1.png")})`,
    ];

    expect(
      orphanedCommentAttachments({ taskId: "tbi_1", removed, kept }),
    ).toEqual(["task-comments/tbi_1/b2.pdf"]);
  });

  it("keeps a file that something kept links to in any form", () => {
    const removed = [
      `![a](${read("task-comments/tbi_1/a1.png")})`,
      `![b](${read("task-comments/tbi_1/b2.png")})`,
    ];
    const kept = [
      // A full URL copied from the browser into the description.
      `https://studio.example.com${read("task-comments/tbi_1/a1.png")}`,
      // A bare URL in prose.
      `look at ${read("task-comments/tbi_1/b2.png")}`,
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
