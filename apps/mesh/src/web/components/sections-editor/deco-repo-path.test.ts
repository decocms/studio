import { describe, expect, test } from "bun:test";
import { decoRepoPath } from "./deco-repo-path";

describe("decoRepoPath", () => {
  test("returns the bare path at the repo root", () => {
    expect(decoRepoPath(null, ".deco/blocks.gen.json")).toBe(
      ".deco/blocks.gen.json",
    );
    expect(decoRepoPath(undefined, ".deco/meta.gen.json")).toBe(
      ".deco/meta.gen.json",
    );
    expect(decoRepoPath("", ".deco/blocks.gen.json")).toBe(
      ".deco/blocks.gen.json",
    );
    expect(decoRepoPath("   ", ".deco/blocks.gen.json")).toBe(
      ".deco/blocks.gen.json",
    );
  });

  test("prefixes the package path when the project is in a subdirectory", () => {
    expect(
      decoRepoPath(
        "eitri-shopping-monte-carlo-shared",
        ".deco/blocks.gen.json",
      ),
    ).toBe("eitri-shopping-monte-carlo-shared/.deco/blocks.gen.json");
  });

  test("normalizes leading and trailing slashes on the package path", () => {
    expect(decoRepoPath("/pkg/", ".deco/meta.gen.json")).toBe(
      "pkg/.deco/meta.gen.json",
    );
    expect(decoRepoPath("pkg", ".deco/meta.gen.json")).toBe(
      "pkg/.deco/meta.gen.json",
    );
  });
});
