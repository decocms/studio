import { describe, expect, test } from "bun:test";
import { isSsoExemptPath, resolveCorsOrigin } from "./app";

describe("isSsoExemptPath", () => {
  test("exempts the legacy unscoped oauth-proxy mount", () => {
    expect(isSsoExemptPath("/oauth-proxy/conn_123/token")).toBe(true);
  });

  test("exempts the canonical org-scoped oauth-proxy mount", () => {
    expect(isSsoExemptPath("/api/acme-corp/oauth-proxy/conn_123/token")).toBe(
      true,
    );
    expect(
      isSsoExemptPath("/api/acme-corp/oauth-proxy/conn_123/register"),
    ).toBe(true);
  });

  test("exempts SSO, auth, tools-management, and admin routes", () => {
    expect(isSsoExemptPath("/api/org-sso/acme-corp")).toBe(true);
    expect(isSsoExemptPath("/api/auth/sign-in")).toBe(true);
    expect(isSsoExemptPath("/api/tools/management")).toBe(true);
    expect(isSsoExemptPath("/api/_admin/orgs")).toBe(true);
  });

  test("does not exempt other org-scoped routes", () => {
    expect(isSsoExemptPath("/api/acme-corp/connections")).toBe(false);
    expect(isSsoExemptPath("/api/acme-corp/mcp/conn_123")).toBe(false);
  });
});

describe("resolveCorsOrigin", () => {
  const ctx = {
    baseUrl: "https://studio.example.com",
    requestOrigin: "https://studio.example.com",
  };

  test("reflects localhost and 127.0.0.1 regardless of port", () => {
    expect(resolveCorsOrigin("http://localhost:4000", ctx)).toBe(
      "http://localhost:4000",
    );
    expect(resolveCorsOrigin("http://127.0.0.1:4000", ctx)).toBe(
      "http://127.0.0.1:4000",
    );
  });

  test("rejects a hostname that merely contains 'localhost'", () => {
    expect(resolveCorsOrigin("http://localhost.evil.com", ctx)).toBeNull();
    expect(resolveCorsOrigin("http://evil-127.0.0.1.com", ctx)).toBeNull();
  });

  test("reflects the configured baseUrl's origin", () => {
    expect(resolveCorsOrigin("https://studio.example.com", ctx)).toBe(
      "https://studio.example.com",
    );
  });

  test("falls back to the request's own origin when baseUrl is unset", () => {
    const noBaseUrl = {
      baseUrl: undefined,
      requestOrigin: "https://self-hosted.internal",
    };
    expect(resolveCorsOrigin("https://self-hosted.internal", noBaseUrl)).toBe(
      "https://self-hosted.internal",
    );
  });

  test("rejects an arbitrary cross-site origin", () => {
    expect(resolveCorsOrigin("https://evil.example", ctx)).toBeNull();
  });

  test("rejects a malformed origin", () => {
    expect(resolveCorsOrigin("not-a-url", ctx)).toBeNull();
  });
});
