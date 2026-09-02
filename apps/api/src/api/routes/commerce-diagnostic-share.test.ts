import { describe, expect, it } from "bun:test";
import {
  diagnosticDeepLinkPath,
  shareInviteBodySchema,
} from "./commerce-diagnostic-share";

describe("diagnosticDeepLinkPath", () => {
  it("builds the deep link that opens the diagnostic app view", () => {
    const path = diagnosticDeepLinkPath("acme", "org_123");
    // Relative (safe redirectTo): the VIEW is the path, everything else search.
    expect(path.startsWith("/acme/agents/app?")).toBe(true);
    const search = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    /** `virtualmcpid`, NOT `project`: the router declares only the former, and
     *  its search schema strips unknown keys — so a link minted with `project`
     *  silently opened on the Super Agent. These URLs are persisted and mailed,
     *  so the key is a wire contract. */
    expect(search.get("virtualmcpid")).toBe("commerce-discovery_org_123");
    expect(search.get("project")).toBeNull();
    expect(search.get("connection")).toBe("org_123_commerce-discovery");
    expect(search.get("tool")).toBe("get_my_diagnostic");
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
