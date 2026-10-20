import { describe, expect, test } from "bun:test";
import { decoDirFor, directoryOf, groupPathsByDirectory } from "./paths";

describe("directoryOf", () => {
  test("a nested path", () => {
    expect(directoryOf(".deco/blocks/page.json")).toBe(".deco/blocks");
  });
  test("a root file has the empty directory", () => {
    expect(directoryOf("README.md")).toBe("");
  });
  test("a leading slash addresses the same file", () => {
    expect(directoryOf("/src/app.ts")).toBe("src");
  });
});

describe("groupPathsByDirectory", () => {
  test("siblings share one bucket", () => {
    expect(
      groupPathsByDirectory([
        ".deco/blocks/a.json",
        ".deco/blocks/b.json",
        ".deco/blocks.gen.json",
      ]),
    ).toEqual(
      new Map([
        [".deco/blocks", [".deco/blocks/a.json", ".deco/blocks/b.json"]],
        [".deco", [".deco/blocks.gen.json"]],
      ]),
    );
  });
  test("duplicates are listed once", () => {
    expect(groupPathsByDirectory(["a/x", "a/x", "/a/x"])).toEqual(
      new Map([["a", ["a/x"]]]),
    );
  });
  test("root files bucket under the empty directory", () => {
    expect(groupPathsByDirectory(["README.md"])).toEqual(
      new Map([["", ["README.md"]]]),
    );
  });
  test("empty and slash-only input yields no buckets", () => {
    expect(groupPathsByDirectory(["", "/", "//"])).toEqual(new Map());
  });
});

describe("decoDirFor", () => {
  test("a repo-root project", () => {
    expect(decoDirFor(null)).toBe(".deco");
  });
  test("a nested project", () => {
    expect(decoDirFor("apps/site")).toBe("apps/site/.deco");
  });
});
