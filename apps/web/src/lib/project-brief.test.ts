import { describe, expect, test } from "bun:test";
import { readWrittenBrief } from "./project-brief";

describe("readWrittenBrief", () => {
  const generatedAt = "2026-09-23T06:00:00Z";

  test("reads the paragraph a workflow wrote", () => {
    expect(
      readWrittenBrief({
        metadata: { project: { brief: { text: "Tudo certo.", generatedAt } } },
      }),
    ).toEqual({ text: "Tudo certo.", generatedAt });
  });

  test("nothing has written one yet", () => {
    expect(readWrittenBrief({})).toBe(null);
    expect(readWrittenBrief({ metadata: { project: {} } })).toBe(null);
  });

  /** A brief with no timestamp cannot be told from one that is three weeks
   *  old, and a stale brief shown as today's is worse than none. */
  test("a brief with no usable timestamp is not a brief", () => {
    expect(
      readWrittenBrief({ metadata: { project: { brief: { text: "hi" } } } }),
    ).toBe(null);
    expect(
      readWrittenBrief({
        metadata: { project: { brief: { text: "hi", generatedAt: "soon" } } },
      }),
    ).toBe(null);
  });

  test("an empty paragraph is not a brief", () => {
    expect(
      readWrittenBrief({
        metadata: { project: { brief: { text: "   ", generatedAt } } },
      }),
    ).toBe(null);
  });
});
