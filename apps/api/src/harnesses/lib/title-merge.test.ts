import { describe, expect, test } from "bun:test";
import { shouldGenerateTitle } from "./title-merge";
import { DEFAULT_THREAD_TITLE } from "./thread-title";

describe("shouldGenerateTitle (D13 producer gate)", () => {
  test("first message of a new thread (title === default) generates a title", () => {
    expect(
      shouldGenerateTitle({ currentThreadTitle: DEFAULT_THREAD_TITLE }),
    ).toBe(true);
    // ...and the same on the main (non-subtask) core path.
    expect(
      shouldGenerateTitle({
        currentThreadTitle: DEFAULT_THREAD_TITLE,
        kind: "main",
      }),
    ).toBe(true);
  });

  test("a later message of an already-titled thread does NOT generate a title", () => {
    expect(
      shouldGenerateTitle({ currentThreadTitle: "Fix login button" }),
    ).toBe(false);
    expect(
      shouldGenerateTitle({
        currentThreadTitle: "Fix login button",
        kind: "main",
      }),
    ).toBe(false);
  });

  test("subtask runs never generate a title, even on the default title", () => {
    expect(
      shouldGenerateTitle({
        currentThreadTitle: DEFAULT_THREAD_TITLE,
        kind: "subtask",
      }),
    ).toBe(false);
  });

  test("null/undefined/empty title does not match the default → no title gen", () => {
    expect(shouldGenerateTitle({ currentThreadTitle: null })).toBe(false);
    expect(shouldGenerateTitle({ currentThreadTitle: undefined })).toBe(false);
    expect(shouldGenerateTitle({ currentThreadTitle: "" })).toBe(false);
  });
});
