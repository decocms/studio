import { describe, expect, test } from "bun:test";
import { branchNameIssue, filesIssues } from "./commit-rules";

describe("branchNameIssue", () => {
  test("accepts the names an app proposes from", () => {
    for (const name of [
      "content-os/review-operar-ecommerce-com-ia",
      "fix/blog-typo",
      "a",
    ])
      expect(branchNameIssue(name)).toBeNull();
  });

  test("refuses what git refuses, and hidden or option-like names", () => {
    for (const name of [
      "",
      "has space",
      "a..b",
      "a//b",
      "-flag",
      "/root",
      "trail/",
      "x.lock",
      "dot.",
      "a/.hidden",
      "colon:x",
      "tilde~1",
      "ref@{1}",
      "x".repeat(256),
    ])
      expect(branchNameIssue(name)).not.toBeNull();
  });
});

describe("filesIssues", () => {
  const file = (path: string, content = "{}") => ({ path, content });

  test("a post and a deletion are fine", () => {
    expect(
      filesIssues([
        file("content/blog/posts/operar-ecommerce-com-ia.json"),
        { path: "content/blog/posts/old.json", deleted: true },
      ]),
    ).toEqual([]);
  });

  test("refuses paths that escape, are absolute or are not normalized", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "../outside.json",
      "content/../../x",
      "content//double.json",
      "./content/x.json",
      "content\\windows.json",
      "content/new\nline.json",
    ])
      expect(filesIssues([file(path)])).toHaveLength(1);
  });

  test("refuses .git/ anywhere and .github/ at the root (CI runs with secrets)", () => {
    expect(filesIssues([file(".git/config")])[0]).toContain(".git/");
    expect(filesIssues([file("sub/.git/HEAD")])[0]).toContain(".git/");
    expect(filesIssues([file(".github/workflows/deploy.yml")])[0]).toContain(
      ".github/",
    );
    // A .github folder below the root is ordinary content.
    expect(filesIssues([file("docs/.github/notes.md")])).toEqual([]);
  });

  test("refuses the same path twice and oversized content", () => {
    expect(filesIssues([file("a.json"), file("a.json")])).toEqual([
      "a.json: listed twice",
    ]);
    expect(
      filesIssues([file("big.json", "x".repeat(1024 * 1024 + 1))])[0],
    ).toContain("over");
    const fifth = "x".repeat(1024 * 1024);
    expect(
      filesIssues(
        Array.from({ length: 6 }, (_, i) => file(`f${i}.json`, fifth)),
      ),
    ).toContain("the files add up to over 5242880 bytes");
  });
});
