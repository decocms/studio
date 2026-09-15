import { describe, expect, it } from "bun:test";
import { matchesAdminToken, tokenAllowsRoute } from "./admin";

describe("matchesAdminToken", () => {
  it("accepts an exact match", () => {
    expect(matchesAdminToken("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(matchesAdminToken("nope", "s3cret")).toBe(false);
    expect(matchesAdminToken("s3cretx", "s3cret")).toBe(false);
  });

  it("stays closed when the secret is unset — an empty header must not open it", () => {
    expect(matchesAdminToken("", "")).toBe(false);
    expect(matchesAdminToken(undefined, undefined)).toBe(false);
    expect(matchesAdminToken("anything", undefined)).toBe(false);
    expect(matchesAdminToken(undefined, "s3cret")).toBe(false);
  });
});

describe("tokenAllowsRoute", () => {
  it("allows any GET", () => {
    expect(tokenAllowsRoute("GET", "/api/_admin/orgs")).toBe(true);
    expect(tokenAllowsRoute("GET", "/api/_admin/orgs/org_1/flags")).toBe(true);
  });

  it("allows member-add", () => {
    expect(tokenAllowsRoute("POST", "/api/_admin/orgs/org_1/members")).toBe(
      true,
    );
  });

  it("rejects org-mutating and impersonation routes", () => {
    expect(tokenAllowsRoute("PUT", "/api/_admin/orgs/org_1/flags")).toBe(false);
    expect(tokenAllowsRoute("POST", "/api/_admin/orgs/org_1/sites")).toBe(
      false,
    );
    expect(tokenAllowsRoute("DELETE", "/api/_admin/orgs/org_1/notice")).toBe(
      false,
    );
    expect(tokenAllowsRoute("POST", "/api/_admin/impersonate")).toBe(false);
  });
});
