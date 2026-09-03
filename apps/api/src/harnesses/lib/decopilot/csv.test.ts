import { describe, expect, it } from "bun:test";
import { csvField } from "./csv";

describe("csvField", () => {
  it("passes plain fields through untouched", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField("")).toBe("");
  });

  it("quotes fields containing a comma, quote, semicolon, or newline", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a;b")).toBe('"a;b"');
    expect(csvField("a\nb")).toBe('"a\nb"');
  });

  it("quotes a bare carriage return", () => {
    expect(csvField("a\rb")).toBe('"a\rb"');
  });
});
