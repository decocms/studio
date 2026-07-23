import { describe, expect, test } from "bun:test";
import { isSsoExemptPath } from "./app";

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
