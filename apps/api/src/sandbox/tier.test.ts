import { describe, expect, it } from "bun:test";
import { resolveSandboxTier } from "./tier";

const MAP = {
  "acme/acme/monorepo": "large",
  acme: "medium",
};

describe("resolveSandboxTier", () => {
  it("prefers the repo-scoped assignment over the org-wide one", () => {
    expect(
      resolveSandboxTier(MAP, {
        orgSlug: "acme",
        repo: { owner: "acme", name: "monorepo" },
      }),
    ).toBe("large");
  });

  it("falls back to the org-wide assignment for another repo", () => {
    expect(
      resolveSandboxTier(MAP, {
        orgSlug: "acme",
        repo: { owner: "acme", name: "website" },
      }),
    ).toBe("medium");
  });

  it("applies the org-wide assignment to a repo-less sandbox", () => {
    expect(resolveSandboxTier(MAP, { orgSlug: "acme", repo: null })).toBe(
      "medium",
    );
  });

  it("returns undefined for an unassigned org so the chart default applies", () => {
    expect(
      resolveSandboxTier(MAP, {
        orgSlug: "other",
        repo: { owner: "acme", name: "monorepo" },
      }),
    ).toBeUndefined();
  });

  it("never applies an assignment without an org scope", () => {
    // A repo key alone must not match — assignment is per (org, repo), so a
    // second org cloning the same public repo can't inherit the tier.
    expect(
      resolveSandboxTier(MAP, { repo: { owner: "acme", name: "monorepo" } }),
    ).toBeUndefined();
  });

  it("matches case-insensitively on owner/repo", () => {
    expect(
      resolveSandboxTier(MAP, {
        orgSlug: "Acme",
        repo: { owner: "ACME", name: "Monorepo" },
      }),
    ).toBe("large");
  });

  it("returns undefined for an empty map", () => {
    expect(
      resolveSandboxTier(
        {},
        { orgSlug: "acme", repo: { owner: "acme", name: "monorepo" } },
      ),
    ).toBeUndefined();
  });

  it("treats an absent map as no overrides instead of throwing", () => {
    // This is the whole provisioning path: SANDBOX_START resolves a tier
    // before calling runner.ensure, so throwing here fails the provision
    // outright. It did — 16 SANDBOX_START tests died on
    // "undefined is not an object" because their getSettings() stub has no
    // sandboxTierMap, and any settings object missing the key would do the
    // same in production.
    expect(
      resolveSandboxTier(undefined, {
        orgSlug: "acme",
        repo: { owner: "acme", name: "monorepo" },
      }),
    ).toBeUndefined();
  });
});
