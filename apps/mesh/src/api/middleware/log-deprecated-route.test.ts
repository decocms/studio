import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import {
  createLogDeprecatedRoute,
  logDeprecatedRoute,
} from "./log-deprecated-route";

type Variables = { meshContext: MeshContext };

const setMeshContext = async (
  c: import("hono").Context<{ Variables: Variables }>,
  next: () => Promise<void>,
) => {
  c.set("meshContext", {
    organization: { slug: "acme" },
    auth: { user: { id: "user-1" } },
  } as unknown as MeshContext);
  await next();
};

describe("logDeprecatedRoute", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let app: Hono<{ Variables: Variables }>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    app = new Hono<{ Variables: Variables }>();
    app.use("*", setMeshContext);
    app.use("/api/legacy/:id", logDeprecatedRoute);
    app.get("/api/legacy/:id", (c) => c.json({ ok: true }));
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("logs the call and continues", async () => {
    const res = await app.request("/api/legacy/abc", {
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

describe("logDeprecatedRoute with sibling sub-app at same mount", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // Reproduces the production false positive: two sub-apps mounted at the
  // same prefix, one permanent and one legacy. A request that the permanent
  // sub-app handles still triggers the legacy sub-app's wildcard middleware,
  // which would otherwise log the permanent route as deprecated.
  const buildSharedMount = (
    mw: ReturnType<typeof createLogDeprecatedRoute>,
  ) => {
    const root = new Hono<{ Variables: Variables }>();
    root.use("*", setMeshContext);

    const permanent = new Hono<{ Variables: Variables }>();
    permanent.get("/profile", (c) => c.json({ ok: true, source: "permanent" }));

    const legacy = new Hono<{ Variables: Variables }>();
    legacy.use("*", mw);
    legacy.get("/", (c) => c.json({ ok: true, source: "legacy" }));

    root.route("/api/deco-sites", permanent);
    root.route("/api/deco-sites", legacy);
    return root;
  };

  it("suppresses the log when the matched handler is in permanentSiblings", async () => {
    const root = buildSharedMount(
      createLogDeprecatedRoute({
        permanentSiblings: new Set(["/api/deco-sites/profile"]),
      }),
    );

    const res = await root.request("/api/deco-sites/profile", {
      headers: { "user-agent": "test-agent" },
    });
    expect(res.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("still logs the legacy sub-app's own routes", async () => {
    const root = buildSharedMount(
      createLogDeprecatedRoute({
        permanentSiblings: new Set(["/api/deco-sites/profile"]),
      }),
    );

    const res = await root.request("/api/deco-sites", {
      headers: { "user-agent": "test-agent" },
    });
    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(
      "deprecated route",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
