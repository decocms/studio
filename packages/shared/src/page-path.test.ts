import { describe, expect, it } from "bun:test";
import { extractPathParams } from "./page-path";

describe("extractPathParams", () => {
  it("extractPathParams lists param names in order, deduped", () => {
    expect(extractPathParams("/inspira-novo/blog/:slug")).toEqual(["slug"]);
    expect(extractPathParams("/:org/:repo/issues/:id")).toEqual([
      "org",
      "repo",
      "id",
    ]);
    expect(extractPathParams("/:slug/compare/:slug")).toEqual(["slug"]);
    expect(extractPathParams("/about")).toEqual([]);
  });

  it("extractPathParams accepts any segment starting with `:`", () => {
    expect(extractPathParams("/x/:fodase")).toEqual(["fodase"]);
    expect(extractPathParams("/c/:my-category")).toEqual(["my-category"]);
    expect(extractPathParams("/v/:123")).toEqual(["123"]);
  });

  it("extractPathParams treats `*` as a catch-all param", () => {
    expect(extractPathParams("/*")).toEqual(["*"]);
    expect(extractPathParams("/c/:category/*")).toEqual(["category", "*"]);
    expect(extractPathParams("/*/x/*")).toEqual(["*"]);
  });
});
