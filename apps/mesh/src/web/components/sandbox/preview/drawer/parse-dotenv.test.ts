import { describe, expect, it } from "bun:test";
import { parseDotenv } from "./parse-dotenv";

describe("parseDotenv", () => {
  it("parses multiple lines", () => {
    expect(parseDotenv("FOO=1\nBAR=2\nBAZ=3")).toEqual({
      FOO: "1",
      BAR: "2",
      BAZ: "3",
    });
  });

  it("skips comments and blank lines", () => {
    expect(parseDotenv("# comment\nFOO=1\n\n# another\nBAR=2\n")).toEqual({
      FOO: "1",
      BAR: "2",
    });
  });

  it("strips matching quotes", () => {
    expect(parseDotenv('KEY="value with spaces"')).toEqual({
      KEY: "value with spaces",
    });
    expect(parseDotenv("KEY='value'")).toEqual({ KEY: "value" });
  });

  it("accepts export prefix", () => {
    expect(parseDotenv("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("rejects invalid key shape", () => {
    expect(() => parseDotenv("9FOO=1")).toThrow(/invalid key/);
    expect(() => parseDotenv("FOO=1\nNOPE")).toThrow(/Line 2/);
  });
});
