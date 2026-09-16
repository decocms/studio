/**
 * A comment's uploaded image is stored as a cookie-authenticated Studio URL,
 * which a sandboxed run cannot fetch. `TASK_BOARD_COMMENT_LIST` points such a
 * run at the org-fs mount instead, and only then tells it those are files.
 */
import { describe, expect, it } from "bun:test";
import { commentsForSandboxRun } from "./comments";

describe("commentsForSandboxRun", () => {
  it("rewrites an upload URL to its sandbox path and adds the hint", () => {
    const out = commentsForSandboxRun([
      {
        id: "c1",
        body: "![shot.png](/api/daniela-tombini/fs/uploads/read?path=editor-images%2Fc0aa15c2.png)",
      },
    ]);
    expect(out.comments[0]!.body).toBe(
      "![shot.png](org/.uploads/editor-images/c0aa15c2.png)",
    );
    expect(out.hint).toContain("Read");
  });

  it("leaves a body with no upload alone, and adds no hint", () => {
    const comments = [{ id: "c1", body: "please make the spacing bigger" }];
    const out = commentsForSandboxRun(comments);
    expect(out.comments).toEqual(comments);
    expect(out.hint).toBeUndefined();
  });

  it("keeps an external image URL untouched", () => {
    const comments = [{ id: "c1", body: "![x](https://example.com/x.png)" }];
    expect(commentsForSandboxRun(comments).comments).toEqual(comments);
  });
});
