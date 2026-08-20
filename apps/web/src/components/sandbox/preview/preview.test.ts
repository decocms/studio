import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, it } from "bun:test";
import { resolvePreviewUrl, withDecoFBT, withDeviceHint } from "./preview";

describe("withDeviceHint", () => {
  it("sets deviceHint on a well-formed URL", () => {
    expect(withDeviceHint("https://example.com/foo", "mobile")).toBe(
      "https://example.com/foo?deviceHint=mobile",
    );
  });

  it("falls back to the original string instead of throwing on a malformed URL", () => {
    expect(withDeviceHint("http://[::1", "mobile")).toBe("http://[::1");
  });
});

describe("withDecoFBT", () => {
  it("passes null through", () => {
    expect(withDecoFBT(null)).toBe(null);
  });

  it("sets __decoFBT=0 on a well-formed URL", () => {
    expect(withDecoFBT("https://example.com/foo")).toBe(
      "https://example.com/foo?__decoFBT=0",
    );
  });

  it("falls back to the original string instead of throwing on a malformed URL", () => {
    expect(withDecoFBT("http://[::1")).toBe("http://[::1");
  });
});

describe("resolvePreviewUrl", () => {
  it("resolves path against base", () => {
    expect(resolvePreviewUrl("/foo", "https://example.com")).toBe(
      "https://example.com/foo",
    );
  });

  it("returns null instead of throwing when base is malformed", () => {
    expect(resolvePreviewUrl("/foo", "http://[::1")).toBe(null);
  });
});
