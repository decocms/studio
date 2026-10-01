import { describe, expect, test } from "bun:test";
import {
  commentAttachmentPath,
  commentAttachmentPaths,
} from "./task-comment-attachments.ts";

const TASK = "board_V1StGXR8Z5jdHi6B";

describe("commentAttachmentPaths", () => {
  test("finds the task's attached image and file", () => {
    const body = [
      "Look at this",
      `![shot.png](/api/acme/fs/uploads/read?path=task-comments%2F${TASK}%2Fa1%2Fshot.png)`,
      `and the spec [spec.pdf](/api/acme/fs/uploads/read?path=task-comments%2F${TASK}%2Fb2%2Fspec.pdf)`,
    ].join("\n");

    expect(commentAttachmentPaths(body, TASK)).toEqual([
      `task-comments/${TASK}/a1/shot.png`,
      `task-comments/${TASK}/b2/spec.pdf`,
    ]);
  });

  test("leaves out files that belong to anything but this task's comments", () => {
    const body = [
      // Another task's attachment, linked from here.
      "![x](/api/acme/fs/uploads/read?path=task-comments%2Fboard_other%2Fa1%2Fx.png)",
      // A description image pasted into the comment.
      "![y](/api/acme/fs/uploads/read?path=editor-images%2Fy.png)",
      // A Library file in another volume that happens to use the same folder.
      `[z](/api/acme/fs/home/read?path=task-comments%2F${TASK}%2Fa1%2Fz.pdf)`,
    ].join("\n");

    expect(commentAttachmentPaths(body, TASK)).toEqual([]);
  });

  test("a path that climbs out of the task's folder is not the task's", () => {
    // Storage resolves the `..`, so the first one would delete board_other's file.
    const body = [
      `![a](/api/acme/fs/uploads/read?path=task-comments%2F${TASK}%2F%2E%2E%2Fboard_other%2Fx.png)`,
      `![b](/api/acme/fs/uploads/read?path=task-comments/${TASK}/../../editor-images/y.png)`,
      `![c](/api/acme/fs/uploads/read?path=task-comments%2F${TASK}%2F.%2Fz.png)`,
      `![d](/api/acme/fs/uploads/read?path=task-comments%2F${TASK}%5C..%5Cboard_other%5Cw.png)`,
    ].join("\n");

    expect(commentAttachmentPaths(body, TASK)).toEqual([]);
  });

  test("only a path shaped like an upload counts, since cleanup removes its folder", () => {
    const body = [
      `![a](/api/acme/fs/uploads/read?path=task-comments%2F${TASK}%2Fx.png)`,
      `![b](/api/acme/fs/uploads/read?path=task-comments%2F${TASK}%2Fa1%2Fdeep%2Fy.png)`,
      `![c](/api/acme/fs/uploads/read?path=task-comments%2F${TASK})`,
    ].join("\n");

    expect(commentAttachmentPaths(body, TASK)).toEqual([]);
  });

  test("a file linked twice is listed once", () => {
    const url = `/api/acme/fs/uploads/read?path=task-comments%2F${TASK}%2Fa1%2Fshot.png`;

    expect(
      commentAttachmentPaths(`![shot](${url}) again ![shot](${url})`, TASK),
    ).toEqual([`task-comments/${TASK}/a1/shot.png`]);
  });

  test("a body without attachments has none", () => {
    expect(commentAttachmentPaths("", TASK)).toEqual([]);
    expect(
      commentAttachmentPaths(
        "see [docs](https://example.com/spec.pdf) and task-comments",
        TASK,
      ),
    ).toEqual([]);
  });
});

/** The read URL the web client builds for a path (`useOrgFsDownloadUrl`). */
function readUrl(path: string): string {
  return `/api/acme/fs/uploads/read?${new URLSearchParams({ path })}`;
}

describe("commentAttachmentPath", () => {
  test("puts each upload in its own folder under the task, so same-named files never collide", () => {
    const first = commentAttachmentPath(TASK, "image.png");
    const second = commentAttachmentPath(TASK, "image.png");

    expect(first).toMatch(
      new RegExp(`^task-comments/${TASK}/[0-9a-f-]{36}/image\\.png$`),
    );
    expect(second).not.toBe(first);
  });

  test("an uploaded path is found again in the comment that links it", () => {
    const path = commentAttachmentPath(TASK, "spec.pdf");

    expect(
      commentAttachmentPaths(`[spec.pdf](${readUrl(path)})`, TASK),
    ).toEqual([path]);
  });

  test.each([
    [
      "Screen Shot 2026-09-30 at 10.12.33.png",
      "Screen-Shot-2026-09-30-at-10.12.33.png",
    ],
    ["relatório final (v2).pdf", "relatorio-final-v2-.pdf"],
    ["../../editor-images/y.png", "..-..-editor-images-y.png"],
    ["..", "file"],
    ["", "file"],
  ])(
    "stores %p as a readable name the comment still finds: %p",
    (name, stored) => {
      const path = commentAttachmentPath(TASK, name);

      expect(path.split("/").at(-1)).toBe(stored);
      expect(commentAttachmentPaths(`[x](${readUrl(path)})`, TASK)).toEqual([
        path,
      ]);
    },
  );

  test.each([
    ["abc", "image/jpeg", "abc.jpg"],
    ["", "image/png", "file.png"],
    ["shot.webp", "image/png", "shot.webp"],
    ["notes", "text/plain", "notes"],
  ])(
    "an image named %p without an extension gets one from its type (%p), so it is served as an image",
    (name, type, stored) => {
      expect(commentAttachmentPath(TASK, name, type).split("/").at(-1)).toBe(
        stored,
      );
    },
  );

  test("a very long name is shortened but keeps its extension", () => {
    const stored = commentAttachmentPath(TASK, `${"a".repeat(300)}.pdf`)
      .split("/")
      .at(-1);

    expect(stored).toBe(`${"a".repeat(96)}.pdf`);
  });
});
