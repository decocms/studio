import { describe, expect, it } from "bun:test";
import { parsePropertiesHeader } from "./context-factory";

describe("parsePropertiesHeader", () => {
  it("parses a valid JSON object of strings", () => {
    expect(parsePropertiesHeader('{"a":"1","b":"2"}')).toEqual({
      a: "1",
      b: "2",
    });
  });

  it("returns undefined for missing/empty/invalid input", () => {
    expect(parsePropertiesHeader(null)).toBeUndefined();
    expect(parsePropertiesHeader("")).toBeUndefined();
    expect(parsePropertiesHeader("not json")).toBeUndefined();
    expect(parsePropertiesHeader("[]")).toBeUndefined();
    expect(parsePropertiesHeader("null")).toBeUndefined();
  });

  it("drops an oversized key/value instead of persisting it", () => {
    const huge = "x".repeat(501);
    expect(
      parsePropertiesHeader(JSON.stringify({ [huge]: "ok" })),
    ).toBeUndefined();
    expect(parsePropertiesHeader(JSON.stringify({ ok: huge }))).toBeUndefined();
  });

  it("caps the number of entries an attacker-controlled header can inject", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 200; i++) many[`k${i}`] = "v";

    const result = parsePropertiesHeader(JSON.stringify(many));
    expect(Object.keys(result ?? {}).length).toBe(50);
  });
});
