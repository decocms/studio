import { describe, expect, test } from "bun:test";
import { computePreviewState } from "./preview-state";
import type { PreviewStateInput } from "./preview-state";

const base: PreviewStateInput = {
  previewUrl: "http://localhost:5173",
  appPaused: false,
  userStopped: false,
  startError: null,
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

  test("startError with no previewUrl → errored", () => {
    const error = {
      code: "GITHUB_NOT_AUTHENTICATED" as const,
      message: "nope",
    };
    expect(
      computePreviewState({ ...base, previewUrl: null, startError: error }),
    ).toEqual({ kind: "errored", error });
  });

  test("startError but a live previewUrl → iframe (running VM wins)", () => {
    expect(
      computePreviewState({
        ...base,
        startError: { code: null, message: "restart failed" },
      }),
    ).toEqual({ kind: "iframe", previewUrl: "http://localhost:5173" });
  });

  test("startError but userStopped → suspended (stop wins)", () => {
    expect(
      computePreviewState({
        ...base,
        previewUrl: null,
        userStopped: true,
        startError: { code: null, message: "x" },
      }),
    ).toEqual({ kind: "suspended" });
  });

  test("othersThreadGate with no previewUrl → othersThread (before starting)", () => {
    expect(
      computePreviewState({
        ...base,
        previewUrl: null,
        othersThreadGate: { label: "tavano-321312" },
      }),
    ).toEqual({ kind: "othersThread", label: "tavano-321312" });
  });

  test("othersThreadGate but a live previewUrl → iframe (acknowledged, VM is running)", () => {
    expect(
      computePreviewState({
        ...base,
        othersThreadGate: { label: "tavano-321312" },
      }),
    ).toEqual({ kind: "iframe", previewUrl: "http://localhost:5173" });
  });

  test("gate beats userStopped when no previewUrl (never boot someone else's branch)", () => {
    expect(
      computePreviewState({
        ...base,
        previewUrl: null,
        userStopped: true,
        othersThreadGate: { label: "tavano-321312" },
      }),
    ).toEqual({ kind: "othersThread", label: "tavano-321312" });
  });

  test("gate beats startError when no previewUrl", () => {
    expect(
      computePreviewState({
        ...base,
        previewUrl: null,
        startError: { code: null, message: "boom" },
        othersThreadGate: { label: "tavano-321312" },
      }),
    ).toEqual({ kind: "othersThread", label: "tavano-321312" });
  });
});
