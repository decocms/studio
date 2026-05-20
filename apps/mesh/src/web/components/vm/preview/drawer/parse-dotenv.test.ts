import { describe, expect, it } from "bun:test";
import { parseDotenv } from "./parse-dotenv";

describe("parseDotenv", () => {
  it("parses single line", () => {
    expect(parseDotenv("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("parses multiple lines", () => {
    expect(parseDotenv("FOO=1\nBAR=2\nBAZ=3")).toEqual({
      FOO: "1",
      BAR: "2",
      BAZ: "3",
    });
  });

  it("skips comments and blank lines", () => {
    const text = "# comment\nFOO=1\n\n# another\nBAR=2\n";
    expect(parseDotenv(text)).toEqual({ FOO: "1", BAR: "2" });
  });

  it("strips matching double quotes", () => {
    expect(parseDotenv('KEY="value with spaces"')).toEqual({
      KEY: "value with spaces",
    });
  });

  it("strips matching single quotes", () => {
    expect(parseDotenv("KEY='value'")).toEqual({ KEY: "value" });
  });

  it("does not strip mismatched quotes", () => {
    expect(parseDotenv(`KEY="value`)).toEqual({ KEY: '"value' });
  });

  it("accepts export prefix", () => {
    expect(parseDotenv("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("accepts CRLF line endings", () => {
    expect(parseDotenv("FOO=1\r\nBAR=2")).toEqual({ FOO: "1", BAR: "2" });
  });

  it("preserves '=' in value", () => {
    expect(parseDotenv("CONN=postgres://user:pass@host/db?ssl=1")).toEqual({
      CONN: "postgres://user:pass@host/db?ssl=1",
    });
  });

  it("rejects line without '='", () => {
    expect(() => parseDotenv("FOO=1\nNOPE")).toThrow(/Line 2/);
  });

  it("rejects invalid key shape", () => {
    expect(() => parseDotenv("9FOO=1")).toThrow(/invalid key/);
  });

  it("rejects key with dash", () => {
    expect(() => parseDotenv("FOO-BAR=1")).toThrow(/invalid key/);
  });

  it("empty input returns empty map", () => {
    expect(parseDotenv("")).toEqual({});
    expect(parseDotenv("\n\n#nothing\n")).toEqual({});
  });

  it("allows empty value", () => {
    expect(parseDotenv("EMPTY=")).toEqual({ EMPTY: "" });
  });
});
