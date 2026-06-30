import { describe, expect, test } from "bun:test";
import { buildDecofileFetchUrl } from "./preview-fetch-url";

const sandbox = {
  orgSlug: "acme",
  virtualMcpId: "vm/one",
  branch: "feature/local-preview",
};

describe("buildDecofileFetchUrl", () => {
  test("uses the browser-reachable preview URL for localhost desktop previews", () => {
    expect(
      buildDecofileFetchUrl({
        ...sandbox,
        previewUrl: "http://abc.localhost:7070/some-page",
      }),
    ).toBe("http://abc.localhost:7070/.decofile");
  });

  test("uses a browser fallback preview URL when params do not include one", () => {
    expect(
      buildDecofileFetchUrl({
        ...sandbox,
        getFallbackPreviewUrl: () => "http://abc.localhost:7070/page",
      }),
    ).toBe("http://abc.localhost:7070/.decofile");
  });

  test("keeps using the API proxy for non-local preview URLs", () => {
    expect(
      buildDecofileFetchUrl({
        ...sandbox,
        previewUrl: "https://abc.preview.example.com/",
      }),
    ).toBe(
      "/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-fetch?path=%2F.decofile",
    );
  });

  test("falls back to the API proxy when no preview URL is available", () => {
    expect(
      buildDecofileFetchUrl({
        ...sandbox,
        previewUrl: undefined,
      }),
    ).toBe(
      "/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-fetch?path=%2F.decofile",
    );
  });
});
