import { describe, expect, test } from "bun:test";
import {
  buildDecofileFetchUrl,
  buildPreviewFetchPath,
  buildPreviewInvokePath,
} from "./preview-fetch-url";

const sandbox = {
  orgSlug: "acme",
  virtualMcpId: "vm/one",
  branch: "feature/local-preview",
  threadId: "thrd_1",
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
      "/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-fetch?thread=thrd_1&path=%2F.decofile",
    );
  });

  test("falls back to the API proxy when no preview URL is available", () => {
    expect(
      buildDecofileFetchUrl({
        ...sandbox,
        previewUrl: undefined,
      }),
    ).toBe(
      "/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-fetch?thread=thrd_1&path=%2F.decofile",
    );
  });
});

describe("buildPreviewInvokePath", () => {
  test("builds the org-scoped studio proxy path", () => {
    expect(
      buildPreviewInvokePath({
        orgSlug: "acme",
        virtualMcpId: "vm-1",
        branch: "main",
        threadId: null,
      }),
    ).toBe("/api/acme/sandbox/vm-1/main/preview-invoke");
  });

  test("encodes slashes in virtualMcpId and branch", () => {
    expect(buildPreviewInvokePath(sandbox)).toBe(
      "/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-invoke?thread=thrd_1",
    );
  });
});

describe("buildPreviewFetchPath", () => {
  test("encodes the path as a query param", () => {
    expect(buildPreviewFetchPath(sandbox, "/granado/cremes")).toBe(
      "/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-fetch?thread=thrd_1&path=%2Fgranado%2Fcremes",
    );
  });
});

describe("thread selector", () => {
  test("a thread-less ref omits the param entirely", () => {
    expect(buildPreviewInvokePath({ ...sandbox, threadId: null })).toBe(
      "/api/acme/sandbox/vm%2Fone/feature%2Flocal-preview/preview-invoke",
    );
  });
});
