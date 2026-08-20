import { describe, expect, test } from "bun:test";
import { resolveFastPreview } from "./fast-preview";

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

  test("an unstamped thread follows the project's capability", () => {
    expect(resolveFastPreview({ fastPreview: true }).active).toBe(false);
    expect(
      resolveFastPreview({ previewServerUrl: "https://acme.com" }).active,
    ).toBe(false);
  });

  // Inverted: a cms stamp is the session's identity and outlives the switch.
  test("a cms stamp stays active without the project capability", () => {
    expect(resolveFastPreview({}, { runtime: "cms" }).active).toBe(true);
  });
});
