import { describe, expect, test } from "bun:test";
import {
  parseThreadRuntime,
  resolveSessionRuntime,
} from "./session-runtime.ts";

const FP_PROJECT = {
  fastPreview: true,
  previewServerUrl: "https://acme.com",
};

describe("resolveSessionRuntime", () => {
  test("unstamped thread on a fast-preview project resolves to cms", () => {
    const r = resolveSessionRuntime(FP_PROJECT, {});
    expect(r.runtime).toBe("cms");
    expect(r.fastPreviewCapability).toBe(true);
    expect(r.previewServerUrl).toBe("https://acme.com/");
  });

  test("absent thread metadata behaves like an unstamped thread", () => {
    expect(resolveSessionRuntime(FP_PROJECT).runtime).toBe("cms");
    expect(resolveSessionRuntime(FP_PROJECT, null).runtime).toBe("cms");
  });

  test("sandbox stamp overrides the fast-preview default", () => {
    const r = resolveSessionRuntime(FP_PROJECT, { runtime: "sandbox" });
    expect(r.runtime).toBe("sandbox");
    // The capability is a project fact — the stamp doesn't erase it.
    expect(r.fastPreviewCapability).toBe(true);
  });

  test("flag without a URL is inert (today's gate)", () => {
    const r = resolveSessionRuntime({ fastPreview: true });
    expect(r.runtime).toBe("sandbox");
    expect(r.fastPreviewCapability).toBe(false);
    expect(r.previewServerUrl).toBeNull();
  });

  test("URL without the flag stays sandbox (today's gate)", () => {
    const r = resolveSessionRuntime({
      previewServerUrl: "https://acme.com",
    });
    expect(r.runtime).toBe("sandbox");
    expect(r.fastPreviewCapability).toBe(false);
    expect(r.previewServerUrl).toBe("https://acme.com/");
  });

  test("legacy productionUrl key satisfies the capability", () => {
    const r = resolveSessionRuntime({
      fastPreview: true,
      productionUrl: "https://legacy.acme.com",
    });
    expect(r.runtime).toBe("cms");
    expect(r.previewServerUrl).toBe("https://legacy.acme.com/");
  });

  test("cms stamp without the capability resolves to sandbox", () => {
    const r = resolveSessionRuntime({}, { runtime: "cms" });
    expect(r.runtime).toBe("sandbox");
  });

  test("cms stamp with the capability resolves to cms", () => {
    const r = resolveSessionRuntime(FP_PROJECT, { runtime: "cms" });
    expect(r.runtime).toBe("cms");
  });

  test("garbage stamps fall through to the default", () => {
    expect(
      resolveSessionRuntime(FP_PROJECT, { runtime: "SANDBOX" }).runtime,
    ).toBe("cms");
    expect(resolveSessionRuntime(FP_PROJECT, { runtime: 1 }).runtime).toBe(
      "cms",
    );
    expect(resolveSessionRuntime({}, { runtime: "weird" }).runtime).toBe(
      "sandbox",
    );
  });

  test("null vmcp metadata resolves to sandbox", () => {
    const r = resolveSessionRuntime(null);
    expect(r.runtime).toBe("sandbox");
    expect(r.fastPreviewCapability).toBe(false);
    expect(r.previewServerUrl).toBeNull();
  });
});

describe("parseThreadRuntime", () => {
  test("accepts only the two runtimes", () => {
    expect(parseThreadRuntime("cms")).toBe("cms");
    expect(parseThreadRuntime("sandbox")).toBe("sandbox");
    expect(parseThreadRuntime("Sandbox")).toBeNull();
    expect(parseThreadRuntime(undefined)).toBeNull();
    expect(parseThreadRuntime(null)).toBeNull();
    expect(parseThreadRuntime(true)).toBeNull();
  });
});
