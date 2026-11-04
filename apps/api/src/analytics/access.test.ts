import { describe, expect, it } from "bun:test";
import type { StudioContext } from "../core/studio-context";
import { analyticsAccess } from "./access";

const ORG = "org-1";
const registration = { id: "s123", key: "dq_abc" };

function ctx(opts: {
  owned?: boolean;
  projects?: { id: string; title: string; metadata?: unknown }[];
  listFails?: boolean;
}): StudioContext {
  return {
    storage: {
      orgSites: {
        isOwnedBy: async () => opts.owned === true,
        getBySlug: async () => undefined,
      },
      virtualMcps: {
        list: async () => {
          if (opts.listFails) throw new Error("db down");
          return opts.projects ?? [];
        },
      },
    },
  } as unknown as StudioContext;
}

describe("analyticsAccess", () => {
  it("reads an owned site through org_sites", async () => {
    expect(await analyticsAccess(ctx({ owned: true }), ORG, "acme")).toEqual({
      kind: "owned",
    });
  });

  it("reads a site deco doesn't host through its project's registration", async () => {
    const c = ctx({
      projects: [
        {
          id: "p1",
          title: "acme",
          metadata: { siteSlug: "acme", decoAnalytics: registration },
        },
      ],
    });
    expect(await analyticsAccess(c, ORG, "acme")).toEqual({
      kind: "external",
      siteId: "s123",
    });
  });

  it("reads an owned slug the control-plane doesn't host through its project's registration", async () => {
    const c = ctx({
      owned: true,
      projects: [
        {
          id: "p1",
          title: "acme",
          metadata: { siteSlug: "acme", decoAnalytics: registration },
        },
      ],
    });
    expect(await analyticsAccess(c, ORG, "acme")).toEqual({
      kind: "external",
      siteId: "s123",
    });
  });

  it("still reads an owned slug when its project lookup fails", async () => {
    expect(
      await analyticsAccess(ctx({ owned: true, listFails: true }), ORG, "acme"),
    ).toEqual({ kind: "owned" });
  });

  it("refuses a project without a registration, and a slug no project has", async () => {
    const c = ctx({
      projects: [{ id: "p1", title: "acme", metadata: { siteSlug: "acme" } }],
    });
    expect(await analyticsAccess(c, ORG, "acme")).toBeNull();
    expect(await analyticsAccess(c, ORG, "other")).toBeNull();
  });

  it("reports a failed project lookup as an error, not as unowned", async () => {
    expect(
      await analyticsAccess(ctx({ listFails: true }), ORG, "acme"),
    ).toEqual({ kind: "error" });
  });
});
