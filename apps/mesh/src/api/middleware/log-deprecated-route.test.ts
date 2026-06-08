import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "../../core/studio-context";
import {
  createLogDeprecatedRoute,
  logDeprecatedRoute,
} from "./log-deprecated-route";

type Variables = { meshContext: StudioContext };

const setStudioContext = async (
  c: import("hono").Context<{ Variables: Variables }>,
  next: () => Promise<void>,
) => {
  c.set("meshContext", {
    organization: { slug: "acme" },
    auth: { user: { id: "user-1" } },
  } as unknown as StudioContext);
  await next();
};

describe("logDeprecatedRoute", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let app: Hono<{ Variables: Variables }>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    app = new Hono<{ Variables: Variables }>();
    app.use("*", setStudioContext);
    app.use("/api/legacy/:id", logDeprecatedRoute);
    app.get("/api/legacy/:id", (c) => c.json({ ok: true }));
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("logs the route metadata when a legacy path is hit", async () => {
    const res = await app.request("/api/legacy/123", {
      headers: { "user-agent": "test-agent" },
    });
    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(
      "deprecated route",
      expect.objectContaining({
        route: "/api/legacy/:id",
        method: "GET",
        org: "acme",
        user: "user-1",
        ua: "test-agent",
      }),
    );
  });
});

// These tests exercise the suppression logic directly by stubbing
// `c.req.matchedRoutes` to mirror what Hono populates in production. We
// can't recreate the full prod routing tree in a unit test (the ordering of
// sub-app mounts plus root-app middleware affects which wildcard handlers
// fire), so we test the middleware's decision logic against the exact
// matchedRoutes shape captured from a real production request to
// `/api/deco-sites/profile`.
describe("createLogDeprecatedRoute suppression logic", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const buildStubContext = (
    matchedRoutes: Array<{
      method: string;
      path: string;
      basePath: string;
    }>,
  ) => {
    // Mirror Hono's `c.req.routePath` for the matched real handler (the
    // first non-wildcard non-ALL entry), since that's what production logs.
    const realHandler = matchedRoutes.find(
      (r) => r.method !== "ALL" && !r.path.endsWith("*"),
    );
    return {
      req: {
        matchedRoutes,
        routePath: realHandler?.path ?? "/",
        method: realHandler?.method ?? "GET",
        path: realHandler?.path ?? "/",
        url: `http://test${realHandler?.path ?? "/"}`,
        header: () => "test-agent",
      },
      get: (key: string) =>
        key === "meshContext"
          ? {
              organization: { slug: "acme" },
              auth: { user: { id: "user-1" } },
            }
          : undefined,
    };
  };

  // Captured from a real prod trace of GET /api/deco-sites/profile while
  // `legacyDecoSitesOrg`'s wildcard middleware fired alongside the user
  // sub-app's `/profile` handler. Both sub-apps are mounted at
  // `/api/deco-sites`, so basePath is identical for both — which is why the
  // basePath check alone isn't sufficient and we need `permanentSiblings`.
  const PROD_PROFILE_MATCHED_ROUTES = [
    { method: "ALL", path: "/api/deco-sites/*", basePath: "/api/deco-sites" },
    {
      method: "GET",
      path: "/api/deco-sites/profile",
      basePath: "/api/deco-sites",
    },
    { method: "ALL", path: "/api/deco-sites/*", basePath: "/api/deco-sites" },
    { method: "ALL", path: "/api/deco-sites/*", basePath: "/api/deco-sites" },
  ];

  it("suppresses the prod /api/deco-sites/profile log via PERMANENT_ROUTES (mountPath-equipped mw)", async () => {
    const mw = createLogDeprecatedRoute({ mountPath: "/api/deco-sites" });
    // biome-ignore lint/suspicious/noExplicitAny: stubbed minimal context
    await mw(
      buildStubContext(PROD_PROFILE_MATCHED_ROUTES) as any,
      async () => {},
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      "deprecated route",
      expect.anything(),
    );
  });

  it("suppresses the prod /api/deco-sites/profile log via PERMANENT_ROUTES (root-mounted mw with no options)", async () => {
    // Regression guard for the bug seen in production after the prior fix:
    // legacyWellKnownProtectedResource is mounted at `/` with the no-options
    // logDeprecatedRoute, which fires for every request and would otherwise
    // log the user sub-app's `/profile` handler as deprecated.
    // biome-ignore lint/suspicious/noExplicitAny: stubbed minimal context
    await logDeprecatedRoute(
      buildStubContext(PROD_PROFILE_MATCHED_ROUTES) as any,
      async () => {},
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      "deprecated route",
      expect.anything(),
    );
  });

  it("suppresses when the responding handler is in a different sub-app (basePath mismatch)", async () => {
    const mw = createLogDeprecatedRoute({ mountPath: "/api" });
    const matched = [
      { method: "ALL", path: "/api/*", basePath: "/api" },
      {
        method: "GET",
        path: "/api/deco-sites/profile",
        basePath: "/api/deco-sites",
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: stubbed minimal context
    await mw(buildStubContext(matched) as any, async () => {});
    expect(logSpy).not.toHaveBeenCalledWith(
      "deprecated route",
      expect.anything(),
    );
  });

  it("suppresses when the responding handler lives under /api/:org/", async () => {
    const mw = createLogDeprecatedRoute({ mountPath: "/api" });
    const matched = [
      { method: "ALL", path: "/api/*", basePath: "/api" },
      {
        method: "GET",
        path: "/api/:org/connections",
        basePath: "/api/:org",
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: stubbed minimal context
    await mw(buildStubContext(matched) as any, async () => {});
    expect(logSpy).not.toHaveBeenCalledWith(
      "deprecated route",
      expect.anything(),
    );
  });

  it("logs when the responding handler belongs to this sub-app", async () => {
    const mw = createLogDeprecatedRoute({ mountPath: "/api" });
    const matched = [
      { method: "ALL", path: "/api/*", basePath: "/api" },
      { method: "GET", path: "/api/kv/:key", basePath: "/api" },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: stubbed minimal context
    await mw(buildStubContext(matched) as any, async () => {});
    expect(logSpy).toHaveBeenCalledWith(
      "deprecated route",
      expect.objectContaining({ route: "/api/kv/:key" }),
    );
  });
});
