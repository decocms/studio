import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import { logDeprecatedRoute } from "./log-deprecated-route";

type Variables = { meshContext: MeshContext };

describe("logDeprecatedRoute", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let app: Hono<{ Variables: Variables }>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    app = new Hono<{ Variables: Variables }>();
    app.use("*", async (c, next) => {
      c.set("meshContext", {
        organization: { slug: "acme" },
        auth: { user: { id: "user-1" } },
      } as unknown as MeshContext);
      await next();
    });
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
