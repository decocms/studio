import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import filesRoutes from "./files";

function buildApp(contentType: string) {
  const fetched: string[] = [];
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();
  app.use("*", async (c, next) => {
    c.set("studioContext", {
      auth: { user: { id: "user_1" } },
      organization: { id: "org_1", slug: "acme", name: "Acme" },
      objectStorage: {
        presignedGetUrl: async (key: string) => {
          fetched.push(key);
          return `data:${contentType};base64,${Buffer.from("<p>x</p>").toString("base64")}`;
        },
      },
    } as unknown as StudioContext);
    await next();
  });
  app.route("/api", filesRoutes);
  return { app, fetched };
}

const APP_CSP = "sandbox allow-scripts";

describe("GET /:org/files/* app-preview keys", () => {
  test.each([
    "/api/acme/files/app-preview/p1/abc/studio.html",
    "/api/acme/files/app-preview%2Fp1/abc/studio.html",
    "/api/acme/files/app-preview%2fp1%2Fabc%2Fstudio.html",
    "/api/acme/files//app-preview/p1/abc/studio.html",
    "/api/acme/files/./app-preview/p1/abc/studio.html",
  ])("%s gets the app sandbox and the normalized key", async (path) => {
    const { app, fetched } = buildApp("text/html");
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(APP_CSP);
    expect(fetched).toEqual(["app-preview/p1/abc/studio.html"]);
  });

  test("other keys keep their raw spelling and policy", async () => {
    const { app, fetched } = buildApp("text/html");
    const res = await app.request("/api/acme/files/uploads%2Fa.html");
    expect(fetched).toEqual(["uploads%2Fa.html"]);
    expect(res.headers.get("content-security-policy")).not.toBe(APP_CSP);
  });
});
