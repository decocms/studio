import { describe, expect, it } from "bun:test";
import type { CheckRun } from "./change-requests";
import { changeRequestPreview, changeRequestPreviewUrl } from "./preview-url";

const run = (over: Partial<CheckRun>): CheckRun => ({
  id: "1",
  name: "build",
  state: "completed",
  conclusion: "success",
  url: null,
  durationMs: null,
  summary: null,
  ...over,
});

describe("changeRequestPreviewUrl", () => {
  const deployRun = run({ url: "https://pr-12--acme.deco.site/" });

  it("reads the preview a CI run links", () => {
    expect(
      changeRequestPreviewUrl({ state: "open", checkRuns: [deployRun] }),
    ).toBe("https://pr-12--acme.deco.site/");
  });

  it("answers nothing for a merged or closed one", () => {
    for (const state of ["merged", "closed"] as const) {
      expect(
        changeRequestPreviewUrl({ state, checkRuns: [deployRun] }),
      ).toBeNull();
    }
  });

  it("ignores links to hosts that are not preview hosts", () => {
    expect(
      changeRequestPreviewUrl({
        state: "open",
        checkRuns: [run({ url: "https://evil.example.com/?x=.deco.site" })],
      }),
    ).toBeNull();
  });
});

describe("changeRequestPreview", () => {
  const open = (checkRuns: CheckRun[]) => ({
    state: "open" as const,
    checkRuns,
  });
  /** deco's commit status while the preview builds: no URL yet. */
  const decoBuilding = run({
    id: null,
    name: "deco/preview",
    state: "running",
    conclusion: null,
    summary: "Building preview…",
  });

  it("is ready once a run links the preview", () => {
    expect(
      changeRequestPreview(
        open([
          run({
            id: null,
            name: "deco/preview",
            url: "https://acme-pr-12-site.deco.site",
          }),
        ]),
      ),
    ).toEqual({ state: "ready", url: "https://acme-pr-12-site.deco.site" });
  });

  it("is building while a preview run has no link yet", () => {
    expect(changeRequestPreview(open([decoBuilding]))).toEqual({
      state: "building",
      url: null,
    });
    expect(
      changeRequestPreview(
        open([
          run({
            name: "Workers Builds: acme",
            state: "queued",
            conclusion: null,
          }),
        ]),
      ).state,
    ).toBe("building");
  });

  it("is failed when the preview run failed", () => {
    expect(
      changeRequestPreview(
        open([
          run({
            id: null,
            name: "deco/preview",
            conclusion: "failure",
          }),
        ]),
      ).state,
    ).toBe("failed");
  });

  it("is none with only other CI", () => {
    expect(
      changeRequestPreview(
        open([run({ name: "build" }), run({ name: "test", state: "running" })]),
      ),
    ).toEqual({ state: "none", url: null });
  });
});
