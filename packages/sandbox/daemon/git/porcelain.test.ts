import { describe, expect, it } from "bun:test";
import { parsePorcelainEntry, parsePorcelainZ } from "./porcelain";

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
