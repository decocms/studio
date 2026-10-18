import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { parseModelJson } from "./fast-tier-json";

describe("parseModelJson", () => {
  const schema = z.object({
    duplicateOf: z.string().nullable(),
    n: z.number(),
  });

  it("reads bare, fenced, and prose-wrapped JSON", () => {
    const want = { duplicateOf: "tbi_1", n: 1 };
    expect(parseModelJson('{"duplicateOf":"tbi_1","n":1}', schema)).toEqual(
      want,
    );
    expect(
      parseModelJson('```json\n{"duplicateOf":"tbi_1","n":1}\n```', schema),
    ).toEqual(want);
    expect(
      parseModelJson(
        'Sure! Here is the verdict: {"duplicateOf":"tbi_1","n":1} Hope that helps.',
        schema,
      ),
    ).toEqual(want);
  });

  it("skips a reasoning model's <think> block and any braces it narrates with", () => {
    const want = { duplicateOf: null, n: 2 };
    expect(
      parseModelJson(
        '<think>Card {A} vs draft... they differ: {"duplicateOf":"tbi_9","n":1}? no.</think>\n{"duplicateOf":null,"n":2}',
        schema,
      ),
    ).toEqual(want);
  });

  it("prefers the last well-formed object, so narration before the answer does not win", () => {
    expect(
      parseModelJson(
        'Comparing to {"duplicateOf":"tbi_1","n":1} earlier... Final: {"duplicateOf":null,"n":3}',
        schema,
      ),
    ).toEqual({ duplicateOf: null, n: 3 });
  });

  it("returns null for no JSON, broken JSON, or the wrong shape", () => {
    expect(parseModelJson("no duplicate found", schema)).toBeNull();
    expect(parseModelJson('{"duplicateOf": "tbi_1", ', schema)).toBeNull();
    expect(parseModelJson('{"duplicateOf": 5, "n": "x"}', schema)).toBeNull();
  });
});
