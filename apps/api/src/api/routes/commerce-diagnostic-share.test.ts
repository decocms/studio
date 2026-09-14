import { describe, expect, it } from "bun:test";
import { projectReportsPath } from "@decocms/shared/organization-paths";
import {
  diagnosticDeepLinkPath,
  shareInviteBodySchema,
} from "./commerce-diagnostic-share";

describe("diagnosticDeepLinkPath", () => {
  it("uses the persisted owner for the Reports destination", () => {
    expect(diagnosticDeepLinkPath("acme", "org_123", " vir_owner ")).toBe(
      projectReportsPath("acme", "vir_owner"),
    );
  });

  it("falls back to the well-known report project for legacy connections", () => {
    expect(diagnosticDeepLinkPath("acme", "org_123", undefined)).toBe(
      projectReportsPath("acme", "commerce-discovery_org_123"),
    );
    expect(diagnosticDeepLinkPath("acme", "org_123", "   ")).toBe(
      projectReportsPath("acme", "commerce-discovery_org_123"),
    );
  });

  it("is a relative path (never absolute/protocol-relative)", () => {
    const path = diagnosticDeepLinkPath("acme", "org_123", "vir_owner");
    expect(path.startsWith("/")).toBe(true);
    expect(path.startsWith("//")).toBe(false);
  });
});

describe("shareInviteBodySchema", () => {
  it("accepts and lowercases-in-caller a valid email, rejects junk", () => {
    expect(
      shareInviteBodySchema.safeParse({ invitee_email: "a@b.com" }).success,
    ).toBe(true);
    expect(
      shareInviteBodySchema.safeParse({ invitee_email: "nope" }).success,
    ).toBe(false);
    expect(shareInviteBodySchema.safeParse({}).success).toBe(false);
  });
});
