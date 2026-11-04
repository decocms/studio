import { describe, expect, test } from "bun:test";
import { readsBrandFile } from "./use-brand-events";

const read = (path: string) => [
  "file-text",
  `/api/acme/fs/home/read?${new URLSearchParams({ path })}`,
];

describe("readsBrandFile", () => {
  test("a brand's guide and tokens are its files", () => {
    expect(
      readsBrandFile(read("brands/aurora/brand.md"), "acme", "aurora"),
    ).toBe(true);
    expect(
      readsBrandFile(read("brands/aurora/tokens.css"), "acme", "aurora"),
    ).toBe(true);
  });

  test("another brand's files, or another org's, are not", () => {
    expect(
      readsBrandFile(read("brands/boreal/brand.md"), "acme", "aurora"),
    ).toBe(false);
    expect(
      readsBrandFile(read("brands/aurora/brand.md"), "other", "aurora"),
    ).toBe(false);
  });

  test("with no brand named, any brand's file counts, and nothing else does", () => {
    expect(readsBrandFile(read("brands/boreal/brand.md"), "acme")).toBe(true);
    expect(readsBrandFile(read("decks/a.html"), "acme")).toBe(false);
    expect(readsBrandFile(["org-fs", "x"], "acme")).toBe(false);
  });
});
