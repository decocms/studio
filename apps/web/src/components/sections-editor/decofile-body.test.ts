import { describe, expect, it } from "bun:test";
import { parseDecofileBody } from "./decofile-body";

describe("parseDecofileBody", () => {
  it("accepts a decofile object", () => {
    expect(parseDecofileBody('{"pages/1":{"__resolveType":"x"}}')).toEqual({
      "pages/1": { __resolveType: "x" },
    });
  });

  it("accepts an empty decofile (a deco site with no blocks yet)", () => {
    expect(parseDecofileBody("{}")).toEqual({});
  });

  it("rejects the SPA fallback html a non-deco dev server serves", () => {
    expect(parseDecofileBody("<!DOCTYPE html>\n<html></html>")).toBeNull();
  });

  it("rejects non-object JSON", () => {
    expect(parseDecofileBody("[]")).toBeNull();
    expect(parseDecofileBody("null")).toBeNull();
    expect(parseDecofileBody('"nope"')).toBeNull();
  });
});
