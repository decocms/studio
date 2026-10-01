import { describe, expect, it } from "bun:test";
import {
  attachmentsAsSandboxPaths,
  sandboxPathsAsAttachments,
} from "./comment-attachments";

const TASK = "board_1";
const pdf =
  "/api/acme/fs/uploads/read?path=task-comments%2Fboard_1%2Fa1%2Fspec.pdf";
const png =
  "/api/acme/fs/uploads/read?path=task-comments%2Fboard_1%2Fb2%2Fshot.png";

describe("attachmentsAsSandboxPaths / sandboxPathsAsAttachments", () => {
  it("a run reads this task's attachments where they are mounted, and writes them back as people wrote them", () => {
    const written = `See [spec.pdf](${pdf})\n\n![shot.png](${png})`;

    const read = attachmentsAsSandboxPaths(written, TASK);

    expect(read).toBe(
      "See [spec.pdf](org/.uploads/task-comments/board_1/a1/spec.pdf)\n\n" +
        "![shot.png](org/.uploads/task-comments/board_1/b2/shot.png)",
    );
    expect(sandboxPathsAsAttachments(read, TASK, "acme")).toBe(written);
  });

  it("leaves every other link in a comment as the URL it is", () => {
    const body = [
      // The agent's own screenshot, already a working URL for people.
      "![qa](/api/acme/fs/outputs/read?path=thrd_1%2Fqa%2Fhome.png)",
      // A Library file someone linked, not an attachment of this comment.
      "[guide](/api/acme/fs/uploads/read?path=My+Brand+Guide.pdf)",
      "[notes](/api/acme/fs/home/read?path=notes%2Fplan.md)",
      // Another task's attachment.
      "[x](/api/acme/fs/uploads/read?path=task-comments%2Fboard_2%2Fa1%2Fx.pdf)",
    ].join("\n");

    expect(attachmentsAsSandboxPaths(body, TASK)).toBe(body);
  });

  it("a run's write-back only restores this task's attachments", () => {
    const body = [
      "![qa](org/output/qa/home.png)",
      "![y](org/.uploads/editor-images/y.png)",
      "[x](org/.uploads/task-comments/board_2/a1/x.pdf)",
      "[z](org/.uploads/task-comments/board_1/a1/../../board_2/a1/x.pdf)",
    ].join("\n");

    expect(sandboxPathsAsAttachments(body, TASK, "acme")).toBe(body);
  });
});
