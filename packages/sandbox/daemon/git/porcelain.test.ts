import { describe, expect, it } from "bun:test";
import {
  parsePorcelainEntry,
  parsePorcelainFiles,
  parsePorcelainZ,
} from "./porcelain";

describe("parsePorcelainEntry", () => {
  it("parses standard spaced format", () => {
    expect(parsePorcelainEntry(" M README.md")).toEqual({
      index: " ",
      working: "M",
      path: "README.md",
    });
  });

  it("parses -z format without separator space", () => {
    expect(parsePorcelainEntry(" MREADME.md")).toEqual({
      index: " ",
      working: "M",
      path: "README.md",
    });
  });
});

describe("parsePorcelainZ", () => {
  it("collects paths from multiple entries", () => {
    const out = " M a.ts\0?? b.ts\0";
    expect(parsePorcelainZ(out)).toEqual(new Set(["a.ts", "b.ts"]));
  });
});

describe("parsePorcelainFiles", () => {
  it("captures the pre-rename path for R entries", () => {
    const out = "R  b.txt\0a.txt\0";
    expect(parsePorcelainFiles(out)).toEqual([
      { path: "b.txt", index: "R", working_dir: " ", origPath: "a.txt" },
    ]);
  });

  it("omits origPath for a plain modification", () => {
    const out = " M a.ts\0";
    expect(parsePorcelainFiles(out)).toEqual([
      { path: "a.ts", index: " ", working_dir: "M" },
    ]);
  });
});
