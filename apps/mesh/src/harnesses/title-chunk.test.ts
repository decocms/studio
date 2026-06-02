import { describe, expect, test } from "bun:test";
import { makeTitleInputChunk, TITLE_INPUT_CHUNK_TYPE } from "./title-chunk";

describe("title-chunk wire format", () => {
  test("TITLE_INPUT_CHUNK_TYPE is the literal 'data-title-input'", () => {
    expect(TITLE_INPUT_CHUNK_TYPE).toBe("data-title-input");
  });

  test("makeTitleInputChunk returns a transient chunk carrying the user message", () => {
    const chunk = makeTitleInputChunk("hello world");
    expect(chunk).toEqual({
      type: "data-title-input",
      data: { userMessage: "hello world" },
      transient: true,
    });
  });

  test("preserves the user message verbatim (no slicing, no trimming)", () => {
    const longMessage = "  pad  ".repeat(50);
    const chunk = makeTitleInputChunk(longMessage);
    expect(chunk.data).toEqual({ userMessage: longMessage });
  });
});
