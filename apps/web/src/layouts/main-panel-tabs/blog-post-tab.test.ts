import { describe, expect, test } from "bun:test";
import { resolvePostBlockKey } from "./blog-post-tab";

/**
 * The URL names the post id because the block key moves when the status
 * crosses the planning/live boundary. If this resolved the wrong way, a writer
 * who schedules a post would find its own URL broken.
 */
describe("resolvePostBlockKey", () => {
  test("finds a draft under the planning prefix", () => {
    expect(resolvePostBlockKey({ "blog-manager/posts/abc": {} }, "abc")).toBe(
      "blog-manager/posts/abc",
    );
  });

  test("finds a published post under the live prefix", () => {
    expect(
      resolvePostBlockKey({ "collections/blog/posts/abc": {} }, "abc"),
    ).toBe("collections/blog/posts/abc");
  });

  test("prefers the live block — it is what the site renders", () => {
    // A promotion can leave the planning block behind; editing it shows nothing.
    expect(
      resolvePostBlockKey(
        {
          "blog-manager/posts/abc": {},
          "collections/blog/posts/abc": {},
        },
        "abc",
      ),
    ).toBe("collections/blog/posts/abc");
  });

  test("reports a deleted post instead of inventing a key", () => {
    expect(resolvePostBlockKey({}, "abc")).toBeNull();
    expect(
      resolvePostBlockKey({ "collections/blog/posts/other": {} }, "abc"),
    ).toBeNull();
  });
});
