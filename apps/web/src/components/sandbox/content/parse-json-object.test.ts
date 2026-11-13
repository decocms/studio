import { describe, expect, test } from "bun:test";
import { parseJsonObject } from "./parse-json-object";

describe("parseJsonObject", () => {
  test("returns a JSON object", () => {
    expect(parseJsonObject('{"a":1,"b":{"c":[1]}}')).toEqual({
      a: 1,
      b: { c: [1] },
    });
    expect(parseJsonObject("{}")).toEqual({});
  });

  test("rejects other JSON values", () => {
    for (const text of ["[]", "[{}]", "null", "1", '"x"', "true"]) {
      expect(parseJsonObject(text)).toBeNull();
    }
  });

  test("rejects invalid and empty text", () => {
    for (const text of ["", " ", "{", '{"a":}', "{a:1}"]) {
      expect(parseJsonObject(text)).toBeNull();
    }
  });
});
