import { describe, expect, it } from "bun:test";
import { csvField } from "./csv";

describe("csvField", () => {
  it("returns empty string for null, undefined, and empty string", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField("")).toBe("");
  });

  it("returns plain strings unquoted", () => {
    expect(csvField("hello")).toBe("hello");
    expect(csvField("core/slides")).toBe("core/slides");
  });

  it("quotes and escapes fields containing a comma", () => {
    expect(csvField("a,b")).toBe('"a,b"');
  });

  it("quotes and doubles embedded quotes", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes fields containing a newline", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("quotes fields containing a semicolon", () => {
    expect(csvField("a;b")).toBe('"a;b"');
  });

  it("quotes a field needing multiple escapes only once, wrapping the whole value", () => {
    expect(csvField('a,"b"\nc;d')).toBe('"a,""b""\nc;d"');
  });
});
