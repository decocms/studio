import { describe, expect, test } from "bun:test";
import { resolveFastPreview, shouldStartBranchAsCms } from "./fast-preview";

const FP_PROJECT = {
  fastPreview: true,
  previewServerUrl: "https://acme.com",
};

describe("resolveFastPreview", () => {
  test("active for an unstamped thread on a fast-preview project", () => {
    expect(resolveFastPreview(FP_PROJECT).active).toBe(true);
    expect(resolveFastPreview(FP_PROJECT, undefined).active).toBe(true);
    expect(resolveFastPreview(FP_PROJECT, {}).active).toBe(true);
  });

  test("inactive when the thread is stamped as a coding session", () => {
    const r = resolveFastPreview(FP_PROJECT, { runtime: "sandbox" });
    expect(r.active).toBe(false);
    // The URL is a project fact and survives the per-thread opt-out.
    expect(r.previewServerUrl).toBe("https://acme.com/");
  });

  test("inactive without the capability regardless of stamps", () => {
    expect(resolveFastPreview({ fastPreview: true }).active).toBe(false);
    expect(
      resolveFastPreview({ previewServerUrl: "https://acme.com" }).active,
    ).toBe(false);
    expect(resolveFastPreview({}, { runtime: "cms" }).active).toBe(false);
  });
});

describe("shouldStartBranchAsCms", () => {
  test("true from a sandbox coding session on a fast-preview project", () => {
    expect(shouldStartBranchAsCms(FP_PROJECT, { runtime: "sandbox" })).toBe(
      true,
    );
  });

  test("false when already in CMS — the in-place switch stays CMS", () => {
    expect(shouldStartBranchAsCms(FP_PROJECT)).toBe(false);
    expect(shouldStartBranchAsCms(FP_PROJECT, undefined)).toBe(false);
    expect(shouldStartBranchAsCms(FP_PROJECT, {})).toBe(false);
    expect(shouldStartBranchAsCms(FP_PROJECT, { runtime: "cms" })).toBe(false);
  });

  test("false without the fast-preview capability, even from a sandbox", () => {
    expect(shouldStartBranchAsCms({ fastPreview: true }, {})).toBe(false);
    expect(
      shouldStartBranchAsCms(
        { previewServerUrl: "https://acme.com" },
        { runtime: "sandbox" },
      ),
    ).toBe(false);
    expect(shouldStartBranchAsCms({}, { runtime: "sandbox" })).toBe(false);
  });
});
