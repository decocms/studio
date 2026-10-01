import { describe, expect, it } from "bun:test";
import { taskCommentAttachmentPaths } from "./task-comment-attachments";

const TASK = "tbi_1";
const read = (path: string) =>
  `/api/acme/fs/uploads/read?path=${encodeURIComponent(path)}`;

describe("taskCommentAttachmentPaths", () => {
  it("finds the task's image and file attachments in a comment body", () => {
    const body = [
      "the checkout breaks on iOS",
      "",
      `![screenshot.png](${read("task-comments/tbi_1/a1.png")})`,
      "",
      `[spec.pdf](${read("task-comments/tbi_1/b2.pdf")})`,
    ].join("\n");

    expect(taskCommentAttachmentPaths(body, TASK)).toEqual([
      "task-comments/tbi_1/a1.png",
      "task-comments/tbi_1/b2.pdf",
    ]);
  });

  it("ignores links that are not this task's attachments", () => {
    const body = [
      // Another task's attachment, pasted in: a link, not ours to own.
      `![other](${read("task-comments/tbi_2/c3.png")})`,
      // A Library file in another volume, at a lookalike path.
      `[home](/api/acme/fs/home/read?path=${encodeURIComponent("task-comments/tbi_1/d4.pdf")})`,
      // A full URL is someone's link, however much its path looks like ours.
      `[abs](https://studio.example.com${read("task-comments/tbi_1/e5.pdf")})`,
      // Climbing out of the task folder.
      `[up](${read("task-comments/tbi_1/../../home/f6.pdf")})`,
      // Undecodable — skipped instead of throwing.
      "[bad](/api/acme/fs/uploads/read?path=task-comments%2Ftbi_1%2F%E0%A4%A)",
      // A bare URL in prose is not a markdown link target.
      `see ${read("task-comments/tbi_1/g7.png")}`,
    ].join("\n\n");

    expect(taskCommentAttachmentPaths(body, TASK)).toEqual([]);
  });

  it("lists a file linked twice once", () => {
    const link = `![shot](${read("task-comments/tbi_1/a1.png")})`;

    expect(taskCommentAttachmentPaths(`${link}\n\n${link}`, TASK)).toEqual([
      "task-comments/tbi_1/a1.png",
    ]);
  });
});
