import { describe, expect, test } from "bun:test";
import {
  buildPublicStudioUrlAtOrigin,
  isProtectedFirstPartyAssetPath,
  isLoopbackStudioOrigin,
  resolveProtectedFirstPartyAssetUrl,
  resolvePublicStudioOrigin,
} from "./transport-rules";

const APP_ORIGIN = "http://localhost:54231";

describe("protected first-party asset URLs", () => {
  test("recognizes only org-scoped protected file routes", () => {
    expect(isProtectedFirstPartyAssetPath("/api/acme/files/logo.png")).toBe(
      true,
    );
    expect(isProtectedFirstPartyAssetPath("/api/acme/files/")).toBe(true);
    expect(isProtectedFirstPartyAssetPath("/api//files/logo.png")).toBe(false);
    expect(
      isProtectedFirstPartyAssetPath("/api/acme/dev-assets/logo.png"),
    ).toBe(false);
    expect(
      isProtectedFirstPartyAssetPath("/api/acme/filesystem/logo.png"),
    ).toBe(false);
  });

  test("localizes exact-upstream protected files and preserves URL suffixes", () => {
    expect(
      resolveProtectedFirstPartyAssetUrl({
        input:
          "https://studio.decocms.com/api/acme/files/brand%20logo.png?v=2#preview",
        upstreamUrl: "https://studio.decocms.com/",
        appOrigin: APP_ORIGIN,
      }),
    ).toBe(`${APP_ORIGIN}/api/acme/files/brand%20logo.png?v=2#preview`);
  });

  test("supports a configured development upstream including its port", () => {
    expect(
      resolveProtectedFirstPartyAssetUrl({
        input: "http://localhost:4000/api/acme/files/logo.png",
        upstreamUrl: "http://localhost:4000",
        appOrigin: APP_ORIGIN,
      }),
    ).toBe(`${APP_ORIGIN}/api/acme/files/logo.png`);
  });

  test("does not rewrite lookalike origins, other routes, or arbitrary assets", () => {
    for (const input of [
      "https://studio.decocms.com.evil.example/api/acme/files/logo.png",
      "https://user:pass@studio.decocms.com/api/acme/files/logo.png",
      "https://studio.decocms.com/api/acme/connections/one",
      "https://cdn.example.com/logo.png",
      "data:image/png;base64,abc",
      "/api/acme/files/already-local.png",
    ]) {
      expect(
        resolveProtectedFirstPartyAssetUrl({
          input,
          upstreamUrl: "https://studio.decocms.com",
          appOrigin: APP_ORIGIN,
        }),
      ).toBe(input);
    }
  });

  test("fails closed for invalid or credential-bearing configuration", () => {
    const input = "https://studio.decocms.com/api/acme/files/logo.png";
    expect(
      resolveProtectedFirstPartyAssetUrl({
        input,
        upstreamUrl: "not a URL",
        appOrigin: APP_ORIGIN,
      }),
    ).toBe(input);
    expect(
      resolveProtectedFirstPartyAssetUrl({
        input,
        upstreamUrl: "https://user:pass@studio.decocms.com",
        appOrigin: APP_ORIGIN,
      }),
    ).toBe(input);
  });
});

describe("public Studio origin", () => {
  test("normal web keeps the current deployment origin", () => {
    expect(
      resolvePublicStudioOrigin({
        browserOrigin: "https://studio.example.com",
      }),
    ).toBe("https://studio.example.com");
  });

  test("native uses the configured upstream origin, without path or trailing slash", () => {
    expect(
      resolvePublicStudioOrigin({
        browserOrigin: APP_ORIGIN,
        upstreamUrl: "https://studio.decocms.com/some/base/",
      }),
    ).toBe("https://studio.decocms.com");
  });

  test("supports an exact development upstream including its port", () => {
    expect(
      resolvePublicStudioOrigin({
        browserOrigin: APP_ORIGIN,
        upstreamUrl: "http://localhost:4000/",
      }),
    ).toBe("http://localhost:4000");
  });

  test("rejects invalid, non-http, and credential-bearing upstream values", () => {
    for (const upstreamUrl of [
      "not a URL",
      "file:///tmp/studio",
      "https://user:pass@studio.decocms.com",
    ]) {
      expect(
        resolvePublicStudioOrigin({
          browserOrigin: APP_ORIGIN,
          upstreamUrl,
        }),
      ).toBe(APP_ORIGIN);
    }
  });

  test("builds every outward-facing route at the public origin", () => {
    for (const [path, expected] of [
      ["/api/acme/mcp/self", "https://studio.decocms.com/api/acme/mcp/self"],
      [
        "/org/acme/registry/mcp",
        "https://studio.decocms.com/org/acme/registry/mcp",
      ],
      [
        "/org/acme/registry/publish-request",
        "https://studio.decocms.com/org/acme/registry/publish-request",
      ],
      [
        "/api/acme/mcp/virtual-mcp/agent-1",
        "https://studio.decocms.com/api/acme/mcp/virtual-mcp/agent-1",
      ],
      [
        "/report/example.com?share_id=one#summary",
        "https://studio.decocms.com/report/example.com?share_id=one#summary",
      ],
      ["/acme", "https://studio.decocms.com/acme"],
      [
        "/api/acme/fs/outputs/read?path=result.pdf",
        "https://studio.decocms.com/api/acme/fs/outputs/read?path=result.pdf",
      ],
    ] as const) {
      expect(
        buildPublicStudioUrlAtOrigin("https://studio.decocms.com", path),
      ).toBe(expected);
    }
  });

  test("rejects absolute and protocol-relative paths", () => {
    expect(() =>
      buildPublicStudioUrlAtOrigin(
        "https://studio.decocms.com",
        "https://evil.example/path",
      ),
    ).toThrow();
    expect(() =>
      buildPublicStudioUrlAtOrigin(
        "https://studio.decocms.com",
        "//evil.example/path",
      ),
    ).toThrow();
  });

  test("classifies development from the public origin, not native loopback", () => {
    expect(isLoopbackStudioOrigin("http://localhost:4000")).toBe(true);
    expect(isLoopbackStudioOrigin("http://studio.localhost:4000")).toBe(true);
    expect(isLoopbackStudioOrigin("http://127.0.0.1:4000")).toBe(true);
    expect(isLoopbackStudioOrigin("http://[::1]:4000")).toBe(true);
    expect(isLoopbackStudioOrigin("https://studio.decocms.com")).toBe(false);
    expect(isLoopbackStudioOrigin("not a URL")).toBe(false);
  });
});
