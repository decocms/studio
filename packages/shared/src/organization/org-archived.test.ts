import { describe, expect, it } from "bun:test";
import { isOrgArchived, parseOrgMetadata } from "./org-archived";

describe("parseOrgMetadata", () => {
  it("parses the JSON string Better Auth returns", () => {
    expect(parseOrgMetadata('{"description":"d","archived":true}')).toEqual({
      description: "d",
      archived: true,
    });
  });

  it("keeps an already-parsed object", () => {
    expect(parseOrgMetadata({ description: "d" })).toEqual({
      description: "d",
    });
  });

  for (const [label, raw] of [
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["unparseable JSON", "{nope"],
    ["a JSON array", "[1,2]"],
    ["a JSON scalar", '"text"'],
    ["a number", 42],
  ] as const) {
    it(`reads ${label} as empty`, () => {
      expect(parseOrgMetadata(raw)).toEqual({});
    });
  }

  it("merges without spreading characters", () => {
    const stored = JSON.stringify({ description: "first", other: 1 });
    const merged: Record<string, unknown> = {
      ...parseOrgMetadata(stored),
      description: "second",
    };
    expect(merged).toEqual({ description: "second", other: 1 });
  });
});

describe("isOrgArchived", () => {
  it("reads both metadata shapes", () => {
    expect(isOrgArchived({ metadata: '{"archived":true}' })).toBe(true);
    expect(isOrgArchived({ metadata: { archived: true } })).toBe(true);
    expect(isOrgArchived({ metadata: '{"archived":false}' })).toBe(false);
    expect(isOrgArchived({ metadata: "{nope" })).toBe(false);
    expect(isOrgArchived(null)).toBe(false);
  });
});
