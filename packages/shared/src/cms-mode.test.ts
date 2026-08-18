import { describe, expect, test } from "bun:test";
import { resolveCmsMode, resolveCmsModeForBranch } from "./cms-mode.ts";

const CMS_PROJECT = {
  cmsMode: true,
  previewServerUrl: "https://preview.example.com",
};

describe("resolveCmsMode", () => {
  test("needs both the flag and a preview server URL", () => {
    expect(resolveCmsMode(CMS_PROJECT).active).toBe(true);
    expect(resolveCmsMode({ cmsMode: true }).active).toBe(false);
    expect(
      resolveCmsMode({ previewServerUrl: "https://preview.example.com" })
        .active,
    ).toBe(false);
  });

  test("reads the legacy fastPreview flag", () => {
    expect(
      resolveCmsMode({
        fastPreview: true,
        previewServerUrl: "https://preview.example.com",
      }).active,
    ).toBe(true);
  });

  test("null metadata is not CMS mode", () => {
    expect(resolveCmsMode(null).active).toBe(false);
    expect(resolveCmsMode(undefined).active).toBe(false);
  });
});

describe("resolveCmsModeForBranch", () => {
  test("a branch with no sandbox is CMS whichever mode is asked for", () => {
    expect(resolveCmsModeForBranch(CMS_PROJECT, false, "cms").active).toBe(
      true,
    );
    // Nothing to vibecode against yet, so the mode cannot override the fact.
    expect(
      resolveCmsModeForBranch(CMS_PROJECT, false, "vibecoding").active,
    ).toBe(true);
  });

  test("with a sandbox, the mode decides", () => {
    expect(resolveCmsModeForBranch(CMS_PROJECT, true, "cms").active).toBe(true);
    expect(
      resolveCmsModeForBranch(CMS_PROJECT, true, "vibecoding").active,
    ).toBe(false);
  });

  /** Switching back restores the CMS workspace, not just the side panel. */
  test("picking CMS on a pod-backed branch returns the CMS gate", () => {
    const vibe = resolveCmsModeForBranch(CMS_PROJECT, true, "vibecoding");
    const back = resolveCmsModeForBranch(CMS_PROJECT, true, "cms");
    expect(vibe.active).toBe(false);
    expect(back.active).toBe(true);
  });

  test("a sandbox never turns a non-CMS project into one", () => {
    expect(
      resolveCmsModeForBranch({ cmsMode: false }, false, "cms").active,
    ).toBe(false);
    expect(resolveCmsModeForBranch(null, true, "cms").active).toBe(false);
  });

  test("the preview server URL survives the narrowing", () => {
    expect(
      resolveCmsModeForBranch(CMS_PROJECT, true, "vibecoding").previewServerUrl,
    ).toBe(resolveCmsMode(CMS_PROJECT).previewServerUrl);
  });
});
