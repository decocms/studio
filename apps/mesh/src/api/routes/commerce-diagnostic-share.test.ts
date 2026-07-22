import { describe, expect, it } from "bun:test";
import {
  diagnosticDeepLinkPath,
  shareInviteBodySchema,
} from "./commerce-diagnostic-share";

describe("diagnosticDeepLinkPath", () => {
  it("builds the org-home deep link that opens the diagnostic app view", () => {
    const path = diagnosticDeepLinkPath("acme", "org_123", "task_abc");
    // Relative (safe redirectTo), correct slug + taskId, and the pinned-view
    // main tab grammar app:<orgId>_commerce-discovery:get_my_diagnostic.
    expect(path.startsWith("/acme/task_abc?")).toBe(true);
    const search = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    expect(search.get("main")).toBe(
      "app:org_123_commerce-discovery:get_my_diagnostic",
    );
    expect(search.get("virtualmcpid")).toBeTruthy();
  });

  it("is a relative path (never absolute/protocol-relative)", () => {
    const path = diagnosticDeepLinkPath("acme", "org_123", "t");
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
