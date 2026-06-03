import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import {
  isTitleInputChunk,
  isTitleResultChunk,
  makeTitleInputChunk,
  makeTitleResultChunk,
  TITLE_INPUT_CHUNK_TYPE,
  TITLE_RESULT_CHUNK_TYPE,
} from "./title-chunk";

describe("title-chunk wire format", () => {
  test("TITLE_INPUT_CHUNK_TYPE is the literal 'data-title-input'", () => {
    expect(TITLE_INPUT_CHUNK_TYPE).toBe("data-title-input");
  });

  test("TITLE_RESULT_CHUNK_TYPE is the literal 'data-title-result'", () => {
    expect(TITLE_RESULT_CHUNK_TYPE).toBe("data-title-result");
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

  test("makeTitleResultChunk returns a transient chunk carrying the title", () => {
    const chunk = makeTitleResultChunk("Generated Title");
    expect(chunk).toEqual({
      type: "data-title-result",
      data: { title: "Generated Title" },
      transient: true,
    });
  });
});

describe("isTitleInputChunk type guard", () => {
  test("returns true for a chunk produced by makeTitleInputChunk", () => {
    const chunk = makeTitleInputChunk("hi") as unknown as UIMessageChunk;
    expect(isTitleInputChunk(chunk)).toBe(true);
  });

  test("returns false for unrelated chunk types", () => {
    expect(
      isTitleInputChunk({
        type: "text-delta",
        id: "1",
        delta: "x",
      } as UIMessageChunk),
    ).toBe(false);
    expect(
      isTitleInputChunk({
        type: "data-thread-title",
        data: { title: "x" },
        transient: true,
      } as unknown as UIMessageChunk),
    ).toBe(false);
  });
});

describe("isTitleResultChunk type guard", () => {
  test("returns true for a chunk produced by makeTitleResultChunk", () => {
    const chunk = makeTitleResultChunk("hi") as unknown as UIMessageChunk;
    expect(isTitleResultChunk(chunk)).toBe(true);
  });

  test("returns false for unrelated chunk types", () => {
    expect(
      isTitleResultChunk({
        type: "text-delta",
        id: "1",
        delta: "x",
      } as UIMessageChunk),
    ).toBe(false);
    expect(
      isTitleResultChunk({
        type: "data-thread-title",
        data: { title: "x" },
        transient: true,
      } as unknown as UIMessageChunk),
    ).toBe(false);
  });
});
