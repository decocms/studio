import { describe, expect, it } from "bun:test";
import {
  diagnosticDeepLinkPath,
  shareInviteBodySchema,
} from "./commerce-diagnostic-share";

describe("diagnosticDeepLinkPath", () => {
  it("builds the deep link that opens the diagnostic app view", () => {
    const path = diagnosticDeepLinkPath("acme", "org_123");
    expect(path).toBe(
      "/acme/projects/commerce-discovery_org_123/apps/org_123_commerce-discovery/get_my_diagnostic",
    );
    expect(path).not.toContain("?");
  });

  it("is a relative path (never absolute/protocol-relative)", () => {
    const path = diagnosticDeepLinkPath("acme", "org_123");
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
