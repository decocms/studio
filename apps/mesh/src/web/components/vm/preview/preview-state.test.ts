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
  userStopped: false,
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
    ).toEqual({ kind: "errored", error: "boom" });
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

  test("notFound triggers starting-now overlay", () => {
    expect(computePreviewState({ ...base, notFound: true })).toEqual({
      kind: "starting-now",
    });
  });

  test("vmStartPending without previewUrl → starting-now", () => {
    expect(
      computePreviewState({
        ...base,
        previewUrl: null,
        vmStartPending: true,
      }),
    ).toEqual({ kind: "starting-now" });
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

  test("previewUrl set, still booting → starting-now overlay", () => {
    expect(computePreviewState({ ...base, status: "booting" })).toEqual({
      kind: "starting-now",
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

  test("no previewUrl, no startError, no pending, no lifecycle → never-started", () => {
    expect(computePreviewState({ ...base, previewUrl: null })).toEqual({
      kind: "never-started",
    });
  });

  test("lifecycleActive with no previewUrl → starting-now", () => {
    expect(
      computePreviewState({
        ...base,
        previewUrl: null,
        claimPhase: { kind: "claiming" },
      }),
    ).toEqual({ kind: "starting-now" });
  });

  test("computePreviewState returns never-started when no previewUrl, no claim, no pending start", () => {
    const out = computePreviewState({
      ...base,
      previewUrl: null,
      status: "booting",
      htmlSupport: false,
      suspended: false,
      appPaused: false,
      vmStartPending: false,
      lastStartError: null,
      claimPhase: null,
      notFound: false,
      userStopped: false,
    });
    expect(out.kind).toBe("never-started");
  });

  test("computePreviewState returns starting-now when vmStartPending is true and previewUrl is null", () => {
    const out = computePreviewState({
      ...base,
      previewUrl: null,
      vmStartPending: true,
    });
    expect(out.kind).toBe("starting-now");
  });

  test("userStopped bypasses notFound and claimPhase → never-started", () => {
    expect(
      computePreviewState({
        ...base,
        previewUrl: null,
        userStopped: true,
        notFound: true,
        claimPhase: { kind: "claiming" },
      }),
    ).toEqual({ kind: "never-started" });
  });

  test("lastStartError still wins over userStopped", () => {
    expect(
      computePreviewState({
        ...base,
        userStopped: true,
        lastStartError: "boom",
      }),
    ).toEqual({ kind: "errored", error: "boom" });
  });

  test("suspended still wins over userStopped", () => {
    expect(
      computePreviewState({
        ...base,
        userStopped: true,
        suspended: true,
      }),
    ).toEqual({ kind: "suspended" });
  });
});
