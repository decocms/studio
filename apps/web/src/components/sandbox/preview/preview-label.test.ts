import { describe, expect, it } from "bun:test";
import { buildPreviewLabel } from "./preview-label";

const NO_SERVER = "No server running";

describe("buildPreviewLabel", () => {
  it("shows the production host under Fast Preview / production surface", () => {
    // iframeBase is production — the label must follow it, not the sandbox.
    expect(
      buildPreviewLabel({
        iframeBase: "https://acme.com",
        resolvedPath: "/",
        activeGlobalSectionName: null,
        noServerLabel: NO_SERVER,
      }),
    ).toBe("acme.com");
  });

  it("shows the sandbox host when the sandbox surface is live", () => {
    expect(
      buildPreviewLabel({
        iframeBase: "https://abc.deco.host",
        resolvedPath: "/",
        activeGlobalSectionName: null,
        noServerLabel: NO_SERVER,
      }),
    ).toBe("abc.deco.host");
  });

  it("appends a non-root path to the host", () => {
    expect(
      buildPreviewLabel({
        iframeBase: "https://acme.com",
        resolvedPath: "/products/shoes",
        activeGlobalSectionName: null,
        noServerLabel: NO_SERVER,
      }),
    ).toBe("acme.com/products/shoes");
  });

  it("omits the path for the root route", () => {
    expect(
      buildPreviewLabel({
        iframeBase: "https://acme.com:8443",
        resolvedPath: "/",
        activeGlobalSectionName: null,
        noServerLabel: NO_SERVER,
      }),
    ).toBe("acme.com:8443");
  });

  it("prefers the pinned global section name over any host", () => {
    expect(
      buildPreviewLabel({
        iframeBase: "https://acme.com",
        resolvedPath: "/",
        activeGlobalSectionName: "Header",
        noServerLabel: NO_SERVER,
      }),
    ).toBe("Header");
  });

  it("falls back to the no-server label when nothing is loaded", () => {
    expect(
      buildPreviewLabel({
        iframeBase: null,
        resolvedPath: "/",
        activeGlobalSectionName: null,
        noServerLabel: NO_SERVER,
      }),
    ).toBe(NO_SERVER);
  });

  it("returns the raw base when it isn't a parseable URL", () => {
    expect(
      buildPreviewLabel({
        iframeBase: "not a url",
        resolvedPath: "/",
        activeGlobalSectionName: null,
        noServerLabel: NO_SERVER,
      }),
    ).toBe("not a url");
  });
});
