import { describe, expect, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { isOrgAdmin, isOrgOwner, validateOIDCUrl } from "./org-sso";

function ctxWith(opts: {
  activeOrgRole?: string;
  targetOrgRole?: string;
}): StudioContext {
  return {
    auth: { user: { id: "user-1", role: opts.activeOrgRole } },
    organization: { id: "org-target", role: opts.targetOrgRole },
  } as unknown as StudioContext;
}

describe("isOrgAdmin / isOrgOwner", () => {
  test("ignore the session's active-org role when it differs from the target org", () => {
    // Owner in the active org, but only a plain member in the org this
    // request actually targets (ctx.organization, set by resolveOrgFromPath).
    const ctx = ctxWith({ activeOrgRole: "owner", targetOrgRole: "user" });
    expect(isOrgAdmin(ctx)).toBe(false);
    expect(isOrgOwner(ctx)).toBe(false);
  });

  test("grant admin/owner based on the target org's role", () => {
    const admin = ctxWith({ activeOrgRole: "user", targetOrgRole: "admin" });
    expect(isOrgAdmin(admin)).toBe(true);
    expect(isOrgOwner(admin)).toBe(false);

    const owner = ctxWith({ activeOrgRole: "user", targetOrgRole: "owner" });
    expect(isOrgAdmin(owner)).toBe(true);
    expect(isOrgOwner(owner)).toBe(true);
  });

  test("recognize comma-joined multi-role owner/admin in the target org", () => {
    const ctx = ctxWith({
      activeOrgRole: "user",
      targetOrgRole: "owner,billing-manager",
    });
    expect(isOrgAdmin(ctx)).toBe(true);
    expect(isOrgOwner(ctx)).toBe(true);
  });

  test("deny when the target org has no resolved role", () => {
    const ctx = ctxWith({ activeOrgRole: "owner", targetOrgRole: undefined });
    expect(isOrgAdmin(ctx)).toBe(false);
    expect(isOrgOwner(ctx)).toBe(false);
  });
});

describe("validateOIDCUrl (SSRF guard)", () => {
  test("rejects the cloud metadata address", async () => {
    await expect(
      validateOIDCUrl(
        "https://169.254.169.254/.well-known/openid-configuration",
      ),
    ).rejects.toThrow();
  });

  test("rejects a private IP literal", async () => {
    await expect(validateOIDCUrl("https://10.0.0.5/x")).rejects.toThrow();
  });

  test("rejects a non-https scheme outside local mode", async () => {
    await expect(validateOIDCUrl("http://8.8.8.8/x")).rejects.toThrow(/HTTPS/);
  });

  test("allows a public https endpoint (IP literal, no DNS)", async () => {
    await expect(validateOIDCUrl("https://8.8.8.8/x")).resolves.toBeUndefined();
  });
});
