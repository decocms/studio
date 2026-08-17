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
  test("a CMS branch with no sandbox is sandbox-less", () => {
    expect(resolveCmsModeForBranch(CMS_PROJECT, false).active).toBe(true);
  });

  /** The project flag stays on; the branch's reads/writes move to the pod. */
  test("a sandbox takes the branch off the sandbox-less path", () => {
    expect(resolveCmsMode(CMS_PROJECT).active).toBe(true);
    expect(resolveCmsModeForBranch(CMS_PROJECT, true).active).toBe(false);
  });

  test("a sandbox never turns a non-CMS project into one", () => {
    expect(resolveCmsModeForBranch({ cmsMode: false }, false).active).toBe(
      false,
    );
    expect(resolveCmsModeForBranch(null, false).active).toBe(false);
  });

  test("the preview server URL survives the narrowing", () => {
    expect(resolveCmsModeForBranch(CMS_PROJECT, true).previewServerUrl).toBe(
      resolveCmsMode(CMS_PROJECT).previewServerUrl,
    );
  });
});
