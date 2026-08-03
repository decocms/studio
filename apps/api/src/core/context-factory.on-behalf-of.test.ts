/**
 * Unit test for the on-behalf-of cross-org guard used by `resolveOnBehalfOfUser`.
 * A self/loopback call authenticates with an org-scoped API key but forwards the
 * real acting user via an `x-studio-token` JWT; this guard decides whether that
 * forwarded identity is trusted for the org the API key is scoped to.
 */
import { describe, expect, it } from "bun:test";
import { isOnBehalfOfTokenOrgAllowed } from "./context-factory";

describe("isOnBehalfOfTokenOrgAllowed", () => {
  it("allows a token scoped to the same org as the API key", () => {
    expect(isOnBehalfOfTokenOrgAllowed("org_1", "org_1")).toBe(true);
  });

  it("denies a token scoped to a different org (the cross-org leak this blocks)", () => {
    expect(isOnBehalfOfTokenOrgAllowed("org_1", "org_2")).toBe(false);
  });

  it("denies a token with no org scope when the API key is org-scoped", () => {
    expect(isOnBehalfOfTokenOrgAllowed("org_1", undefined)).toBe(false);
  });

  it("allows any token when the API key itself is not org-scoped", () => {
    expect(isOnBehalfOfTokenOrgAllowed(undefined, "org_2")).toBe(true);
    expect(isOnBehalfOfTokenOrgAllowed(undefined, undefined)).toBe(true);
  });
});
