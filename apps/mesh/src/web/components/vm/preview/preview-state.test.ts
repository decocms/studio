import { describe, expect, test } from "bun:test";
import { computePreviewState } from "./preview-state";
import type { PreviewStateInput } from "./preview-state";

const base: PreviewStateInput = {
  previewUrl: "http://localhost:5173",
  status: "booting",
  htmlSupport: false,
  suspended: false,
  appPaused: false,
  vmStartPending: false,
  lastStartError: null,
  claimPhase: null,
  notFound: false,
};

describe("computePreviewState", () => {
  test("error wins over everything", () => {
    expect(
      computePreviewState({
        ...base,
        lastStartError: "boom",
        status: "online",
        htmlSupport: true,
      }),
    ).toEqual({ kind: "error", error: "boom" });
  });

  test("suspended wins over content states", () => {
    expect(
      computePreviewState({
        ...base,
        suspended: true,
        status: "online",
        htmlSupport: true,
      }),
    ).toEqual({ kind: "suspended" });
  });

  test("appPaused wins over content states", () => {
    expect(
      computePreviewState({
        ...base,
        appPaused: true,
        status: "online",
        htmlSupport: true,
      }),
    ).toEqual({ kind: "suspended" });
  });

  test("notFound triggers booting overlay", () => {
    expect(computePreviewState({ ...base, notFound: true })).toEqual({
      kind: "booting",
    });
  });

  test("vmStartPending without previewUrl → booting", () => {
    expect(
      computePreviewState({
        ...base,
        previewUrl: null,
        vmStartPending: true,
      }),
    ).toEqual({ kind: "booting" });
  });

  test("previewUrl set, online but not html → no-html empty state", () => {
    expect(
      computePreviewState({ ...base, status: "online", htmlSupport: false }),
    ).toEqual({ kind: "no-html", previewUrl: "http://localhost:5173" });
  });

  test("previewUrl set, online and html → iframe", () => {
    expect(
      computePreviewState({ ...base, status: "online", htmlSupport: true }),
    ).toEqual({ kind: "iframe", previewUrl: "http://localhost:5173" });
  });

  test("previewUrl set, still booting → booting overlay", () => {
    expect(computePreviewState({ ...base, status: "booting" })).toEqual({
      kind: "booting",
    });
  });

  test("offline persists iframe across transient drops (htmlSupport sticky)", () => {
    expect(
      computePreviewState({ ...base, status: "offline", htmlSupport: true }),
    ).toEqual({ kind: "iframe", previewUrl: "http://localhost:5173" });
  });

  test("offline persists no-html across transient drops", () => {
    expect(
      computePreviewState({ ...base, status: "offline", htmlSupport: false }),
    ).toEqual({ kind: "no-html", previewUrl: "http://localhost:5173" });
  });

  test("no previewUrl, no startError, no pending, no lifecycle → idle", () => {
    expect(computePreviewState({ ...base, previewUrl: null })).toEqual({
      kind: "idle",
    });
  });

  test("lifecycleActive with no previewUrl → booting", () => {
    expect(
      computePreviewState({
        ...base,
        previewUrl: null,
        claimPhase: { kind: "claiming" },
      }),
    ).toEqual({ kind: "booting" });
  });
});
