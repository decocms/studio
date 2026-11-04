import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { StudioContext } from "../core/studio-context";
import { getSettings, setGlobalSettings } from "../settings";
import { analyticsAccess, ownedAnalyticsSiteId } from "./access";

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

describe("ownedAnalyticsSiteId", () => {
  const original = getSettings();
  beforeAll(() =>
    setGlobalSettings({
      ...original,
      controlplaneRestUrl: "https://cp.test/api/v1",
      controlplaneServiceToken: "test-token",
    }),
  );
  afterAll(() => setGlobalSettings(original));

  const hosted = ctx({
    owned: true,
    projects: [{ id: "p1", title: "acme", metadata: { siteSlug: "acme" } }],
  });

  it("reads the registration an unhosted slug's project carries, without the control-plane", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
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
      expect(await ownedAnalyticsSiteId(c, ORG, "acme")).toEqual({
        status: "registered",
        id: "s123",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to the control-plane's registration for a hosted slug", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        registered: true,
        host: "acme.com",
        key: null,
        config: { id: "s42", modules: ["core"] },
      }),
    );
    try {
      expect(await ownedAnalyticsSiteId(hosted, ORG, "acme")).toEqual({
        status: "registered",
        id: "s42",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to the control-plane when the project lookup fails, and errors when it has no record either", async () => {
    const failing = ctx({ owned: true, listFails: true });
    const fetchSpy = spyOn(globalThis, "fetch");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      fetchSpy.mockResolvedValueOnce(
        Response.json({
          registered: true,
          host: "acme.com",
          key: null,
          config: { id: "s42", modules: ["core"] },
        }),
      );
      expect(await ownedAnalyticsSiteId(failing, ORG, "acme")).toEqual({
        status: "registered",
        id: "s42",
      });
      fetchSpy.mockResolvedValueOnce(
        Response.json(
          { error: "not_found", message: "unknown site: acme" },
          { status: 404 },
        ),
      );
      expect(await ownedAnalyticsSiteId(failing, ORG, "acme")).toEqual({
        status: "error",
      });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("answers unregistered for a slug the control-plane has no record of, and error on an outage", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      fetchSpy.mockResolvedValueOnce(
        Response.json(
          { error: "not_found", message: "unknown site: acme" },
          { status: 404 },
        ),
      );
      expect(await ownedAnalyticsSiteId(hosted, ORG, "acme")).toEqual({
        status: "unregistered",
      });
      fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 500 }));
      expect(await ownedAnalyticsSiteId(hosted, ORG, "acme")).toEqual({
        status: "error",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
