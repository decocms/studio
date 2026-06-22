import { describe, expect, test } from "bun:test";
import { buildPreviewFetchUrl } from "./preview-fetch-url";

const sandbox = {
  orgSlug: "acme",
  virtualMcpId: "vm/one",
  branch: "feature/local-preview",
};

describe("buildPreviewFetchUrl", () => {
  test("uses the browser-reachable preview URL for localhost desktop previews", () => {
    expect(
      buildPreviewFetchUrl({
        ...sandbox,
        previewUrl: "http://abc.localhost:7070/some-page",
        path: "/.decofile",
      }),
    ).toBe("http://abc.localhost:7070/.decofile");
  });

  test("uses a browser fallback preview URL when params do not include one", () => {
    expect(
      buildPreviewFetchUrl({
        ...sandbox,
        getFallbackPreviewUrl: () => "http://abc.localhost:7070/page",
        path: "/live/_meta",
      }),
    ).toBe("http://abc.localhost:7070/live/_meta");
  });

  test("keeps using the API proxy for non-local preview URLs", () => {
    expect(
      buildPreviewFetchUrl({
        ...sandbox,
        previewUrl: "https://abc.preview.example.com/",
        path: "/live/_meta",
      }),
    ).toBe(
      "/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-fetch?path=%2Flive%2F_meta",
    );
  });

  test("falls back to the API proxy when no preview URL is available", () => {
    expect(
      buildPreviewFetchUrl({
        ...sandbox,
        previewUrl: undefined,
        path: "/.decofile",
      }),
    ).toBe(
      "/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-fetch?path=%2F.decofile",
    );
  });
});
