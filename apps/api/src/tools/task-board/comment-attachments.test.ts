import { describe, expect, it } from "bun:test";
import {
  attachmentsAsSandboxPaths,
  foldersToDelete,
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
    expect(sandboxPathsAsAttachments(read, "acme")).toBe(written);
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
      // This task's attachment, but as an absolute link someone copied.
      `[abs](https://studio.example.com${pdf})`,
    ].join("\n");

    expect(attachmentsAsSandboxPaths(body, TASK)).toBe(body);
  });

  it("a run's write-back restores any task's attachment it read, and nothing else", () => {
    // A run may list another task's comments and quote what it found there.
    expect(
      sandboxPathsAsAttachments(
        "[x](org/.uploads/task-comments/board_2/a1/x.pdf)",
        "acme",
      ),
    ).toBe(
      "[x](/api/acme/fs/uploads/read?path=task-comments%2Fboard_2%2Fa1%2Fx.pdf)",
    );

    const body = [
      "![qa](org/output/qa/home.png)",
      "![y](org/.uploads/editor-images/y.png)",
      "[z](org/.uploads/task-comments/board_1/a1/../../board_2/a1/x.pdf)",
    ].join("\n");
    expect(sandboxPathsAsAttachments(body, "acme")).toBe(body);
  });
});

describe("foldersToDelete", () => {
  const link = (path: string) =>
    `[f](/api/acme/fs/uploads/read?${new URLSearchParams({ path })})`;

  it("removes the upload folder a removed comment linked, once nothing else links it", () => {
    expect(
      foldersToDelete(
        [link("task-comments/board_1/u1/spec.pdf")],
        [link("task-comments/board_1/u2/other.pdf")],
        TASK,
      ),
    ).toEqual(["task-comments/board_1/u1"]);
  });

  it("keeps a folder another comment still links, even under a different file name", () => {
    // Removing the folder would take the file Bob's comment still shows.
    expect(
      foldersToDelete(
        [link("task-comments/board_1/u1/nope.png")],
        [link("task-comments/board_1/u1/shot.png")],
        TASK,
      ),
    ).toEqual([]);
  });

  it("lists each folder once", () => {
    expect(
      foldersToDelete(
        [
          link("task-comments/board_1/u1/a.png"),
          link("task-comments/board_1/u1/b.png"),
        ],
        [],
        TASK,
      ),
    ).toEqual(["task-comments/board_1/u1"]);
  });
});
