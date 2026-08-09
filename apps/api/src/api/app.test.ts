import { describe, expect, test } from "bun:test";
import {
  isAllowedOAuthRedirectUri,
  isSsoExemptPath,
  resolveCorsOrigin,
} from "./app";

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

  test("reflects the native desktop app's local control origin regardless of port", () => {
    expect(
      resolveCorsOrigin("https://local.studio.decocms.com:4420", ctx),
    ).toBe("https://local.studio.decocms.com:4420");
    expect(
      resolveCorsOrigin("https://local.studio.decocms.com:43120", ctx),
    ).toBe("https://local.studio.decocms.com:43120");
  });

  test("rejects a hostname that merely contains the desktop control origin", () => {
    expect(
      resolveCorsOrigin("https://local.studio.decocms.com.evil.example", ctx),
    ).toBeNull();
    expect(
      resolveCorsOrigin("https://evil.local.studio.decocms.com", ctx),
    ).toBeNull();
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

describe("isAllowedOAuthRedirectUri", () => {
  const allowedOrigin = "https://studio.example.com";

  test("allows this deployment's own origin", () => {
    expect(
      isAllowedOAuthRedirectUri(
        new URL("https://studio.example.com/oauth/callback"),
        allowedOrigin,
      ),
    ).toBe(true);
  });

  test("allows bare localhost on any port", () => {
    expect(
      isAllowedOAuthRedirectUri(
        new URL("http://localhost:4000/callback"),
        allowedOrigin,
      ),
    ).toBe(true);
  });

  test("allows the native desktop app's local control origin regardless of port", () => {
    expect(
      isAllowedOAuthRedirectUri(
        new URL("https://local.studio.decocms.com:4420/_auth/mcp-callback"),
        allowedOrigin,
      ),
    ).toBe(true);
    expect(
      isAllowedOAuthRedirectUri(
        new URL("https://local.studio.decocms.com:43120/_auth/mcp-callback"),
        allowedOrigin,
      ),
    ).toBe(true);
  });

  test("rejects a hostname that merely contains the desktop control origin", () => {
    expect(
      isAllowedOAuthRedirectUri(
        new URL("https://local.studio.decocms.com.evil.example/callback"),
        allowedOrigin,
      ),
    ).toBe(false);
    expect(
      isAllowedOAuthRedirectUri(
        new URL("https://evil.local.studio.decocms.com/callback"),
        allowedOrigin,
      ),
    ).toBe(false);
  });

  test("rejects an arbitrary cross-site redirect_uri", () => {
    expect(
      isAllowedOAuthRedirectUri(
        new URL("https://evil.example/steal-code"),
        allowedOrigin,
      ),
    ).toBe(false);
  });
});
