import { describe, expect, it } from "bun:test";
import {
  generateInviteLinkToken,
  hashInviteLinkToken,
  isSafeInviteRedirect,
} from "./invite-link-token";

describe("isSafeInviteRedirect", () => {
  it("accepts paths inside the org", () => {
    expect(isSafeInviteRedirect("/acme", "acme")).toBe(true);
    expect(isSafeInviteRedirect("/acme/apps/x?tab=1", "acme")).toBe(true);
    expect(isSafeInviteRedirect("/acme?x=1", "acme")).toBe(true);
  });

  it("rejects absolute, protocol-relative and other-org targets", () => {
    expect(isSafeInviteRedirect("https://evil.test/acme", "acme")).toBe(false);
    expect(isSafeInviteRedirect("//evil.test/acme", "acme")).toBe(false);
    expect(isSafeInviteRedirect("/\\evil.test", "acme")).toBe(false);
    expect(isSafeInviteRedirect("/other/apps", "acme")).toBe(false);
    expect(isSafeInviteRedirect("/acme-evil", "acme")).toBe(false);
    expect(isSafeInviteRedirect("", "acme")).toBe(false);
  });
});

describe("invite link tokens", () => {
  it("are unique, URL-safe, and hash deterministically", async () => {
    const a = generateInviteLinkToken();
    const b = generateInviteLinkToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await hashInviteLinkToken(a)).toBe(await hashInviteLinkToken(a));
    expect(await hashInviteLinkToken(a)).not.toBe(await hashInviteLinkToken(b));
  });
});
