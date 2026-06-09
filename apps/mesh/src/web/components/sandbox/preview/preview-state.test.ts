import { describe, expect, test } from "bun:test";
import { computePreviewState } from "./preview-state";
import type { PreviewStateInput } from "./preview-state";

const base: PreviewStateInput = {
  previewUrl: "http://localhost:5173",
  appPaused: false,
  userStopped: false,
};

describe("computePreviewState", () => {
  test("previewUrl present → iframe", () => {
    expect(computePreviewState(base)).toEqual({
      kind: "iframe",
      previewUrl: "http://localhost:5173",
    });
  });

  test("no previewUrl → starting", () => {
    expect(computePreviewState({ ...base, previewUrl: null })).toEqual({
      kind: "starting",
    });
  });

  test("appPaused → suspended (even with a previewUrl)", () => {
    expect(computePreviewState({ ...base, appPaused: true })).toEqual({
      kind: "suspended",
    });
  });

  test("userStopped → suspended (even with a previewUrl)", () => {
    expect(computePreviewState({ ...base, userStopped: true })).toEqual({
      kind: "suspended",
    });
  });
});
