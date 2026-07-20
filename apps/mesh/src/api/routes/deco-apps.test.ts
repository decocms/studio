import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "../../core/studio-context";
import {
  createDecoAppsRoutes,
  mapSupabaseAppRows,
  type SupabaseAppRow,
} from "./deco-apps";

describe("mapSupabaseAppRows", () => {
  test("maps rows with vendor alias and drops rows without vendor", () => {
    const rows: SupabaseAppRow[] = [
      {
        name: "vtex",
        title: "VTEX",
        description: "Ecommerce",
        logo: "https://example.com/vtex.png",
        category: "Ecommerce",
        vendors: { alias: "deco", url: "https://apps.deco.cx" },
      },
      {
        name: "orphan",
        title: "Orphan",
        description: "",
        logo: "",
        category: null,
        vendors: null,
      },
    ];

    expect(mapSupabaseAppRows(rows)).toEqual([
      {
        name: "vtex",
        title: "VTEX",
        description: "Ecommerce",
        logo: "https://example.com/vtex.png",
        category: "Ecommerce",
        vendor: { alias: "deco", url: "https://apps.deco.cx" },
      },
    ]);
  });
});

describe("createDecoAppsRoutes", () => {
  test("returns 401 when unauthenticated", async () => {
    const root = new Hono<{ Variables: { studioContext: StudioContext } }>();
    root.use("*", async (c, next) => {
      c.set("studioContext", {
        auth: { user: null },
      } as unknown as StudioContext);
      await next();
    });
    root.route("/", createDecoAppsRoutes());

    const res = await root.request("/");
    expect(res.status).toBe(401);
  });
});
