import { describe, expect, it } from "bun:test";
import { taskCommentAttachmentPaths } from "./task-comment-attachments";

const TASK = "tbi_1";
// Names as the composer writes them: a fresh UUID plus the file's extension.
const SHOT = "0b7c2f8e-3d1a-4c5b-9e6f-1a2b3c4d5e6f.png";
const SPEC = "5f1e9a2b-7c3d-4e8f-a1b2-c3d4e5f6a7b8.pdf";
const read = (path: string) =>
  `/api/acme/fs/uploads/read?path=${encodeURIComponent(path)}`;

describe("taskCommentAttachmentPaths", () => {
  it("finds the task's image and file attachments in a comment body", () => {
    const body = [
      "the checkout breaks on iOS",
      "",
      `![screenshot.png](${read(`task-comments/tbi_1/${SHOT}`)})`,
      "",
      `[spec.pdf](${read(`task-comments/tbi_1/${SPEC}`)})`,
    ].join("\n");

    expect(taskCommentAttachmentPaths(body, TASK)).toEqual([
      `task-comments/tbi_1/${SHOT}`,
      `task-comments/tbi_1/${SPEC}`,
    ]);
  });

  it("ignores links that are not this task's attachments", () => {
    const body = [
      // Another task's attachment, pasted in: a link, not ours to own.
      `![other](${read(`task-comments/tbi_2/${SHOT}`)})`,
      // A Library file in another volume, at a lookalike path.
      `[home](/api/acme/fs/home/read?path=${encodeURIComponent(`task-comments/tbi_1/${SPEC}`)})`,
      // A full URL is someone's link, however much its path looks like ours.
      `[abs](https://studio.example.com${read(`task-comments/tbi_1/${SPEC}`)})`,
      // Undecodable — skipped instead of throwing.
      "[bad](/api/acme/fs/uploads/read?path=task-comments%2Ftbi_1%2F%E0%A4%A)",
      // A bare URL in prose is not a markdown link target.
      `see ${read(`task-comments/tbi_1/${SHOT}`)}`,
    ].join("\n\n");

    expect(taskCommentAttachmentPaths(body, TASK)).toEqual([]);
  });

  // `orgFs.delete` decodes again and resolves `\`, `.` and `..`, so only the composer's own name format passes.
  it("never yields a path the file store would resolve outside the task's folder", () => {
    const body = [
      `[up](${read("task-comments/tbi_1/../../home/report.pdf")})`,
      `[backslash](${read("task-comments/tbi_1/..\\..\\editor-images")})`,
      "[double](/api/acme/fs/uploads/read?path=task-comments%2Ftbi_1%2F%252e%252e%252feditor-images)",
      "[nul](/api/acme/fs/uploads/read?path=task-comments%2Ftbi_1%2F..%00)",
      `[dot](${read("task-comments/tbi_1/.")})`,
      `[nested](${read(`task-comments/tbi_1/x/${SHOT}`)})`,
      `[not-ours](${read("task-comments/tbi_1/report.pdf")})`,
    ].join("\n\n");

    expect(taskCommentAttachmentPaths(body, TASK)).toEqual([]);
  });

  it("lists a file linked twice once", () => {
    const link = `![shot](${read(`task-comments/tbi_1/${SHOT}`)})`;

    expect(taskCommentAttachmentPaths(`${link}\n\n${link}`, TASK)).toEqual([
      `task-comments/tbi_1/${SHOT}`,
    ]);
  });
});
