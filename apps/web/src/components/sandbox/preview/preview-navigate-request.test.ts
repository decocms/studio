import { describe, expect, test } from "bun:test";
import { sameOriginPreviewPath } from "./preview-navigate-request";

describe("sameOriginPreviewPath", () => {
  test("keeps a path with its query and hash", () => {
    expect(sameOriginPreviewPath("/search?q=shoes#top")).toBe(
      "/search?q=shoes#top",
    );
    expect(sameOriginPreviewPath("/")).toBe("/");
  });

  test("rejects anything that leaves the dev server", () => {
    for (const path of [
      "//evil.test/x",
      "/\\evil.test/x",
      "https://evil.test/",
      "javascript:alert(1)",
    ]) {
      expect(sameOriginPreviewPath(path)).toBeNull();
    }
  });
});
