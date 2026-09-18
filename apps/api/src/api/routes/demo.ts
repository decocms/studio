import { Hono } from "hono";
import { DemoRecipeSchema } from "@decocms/shared/demo";
import type { Env } from "../hono-env";
import { changePage } from "@/demo/artifacts";

import { storefrontKey } from "@/demo/bundle";

export function createDemoRoutes() {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    const ctx = c.get("studioContext");
    ctx.access.setToolName?.("DEMO_STATUS");
    await ctx.access.check();
    if (!ctx.organization || !(await ctx.storage.demo.get(ctx.organization.id)))
      return c.notFound();
    c.header("Cache-Control", "no-store");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    return next();
  });
  app.get("/assets/:name", async (c) => {
    if (!/^[a-f0-9]{64}$/.test(c.req.param("name"))) return c.notFound();
    const ctx = c.get("studioContext");
    const asset = await ctx.storage.demo.asset(
      ctx.organization!.id,
      c.req.param("name"),
    );
    if (!asset) return c.notFound();
    c.header("Content-Type", asset.mime);
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(Buffer.from(asset.body, "base64"));
  });
  app.get("/storefront", async (c) => {
    const ctx = c.get("studioContext");
    const published = await ctx.storage.demo.publishedRecipes(
      ctx.organization!.id,
    );
    const bundle = await ctx.storage.demo.bundle(ctx.organization!.id);
    return c.html(
      bundle.storefront[storefrontKey(published)].replaceAll(
        "__DEMO_ASSET_BASE__",
        `/api/${encodeURIComponent(ctx.organization!.slug!)}/demo/assets`,
      ),
    );
  });
  for (const kind of ["preview", "changes"] as const) {
    app.get(`/${kind}/:taskId`, async (c) => {
      const ctx = c.get("studioContext");
      const item = await ctx.storage.demo.artifact(
        ctx.organization!.id,
        c.req.param("taskId"),
      );
      if (!item?.delivered) return c.notFound();
      const recipe = DemoRecipeSchema.parse(item.recipe);
      const bundle = await ctx.storage.demo.bundle(ctx.organization!.id);
      return c.html(
        kind === "preview"
          ? bundle.storefront[
              c.req.query("before") === "1" ? "base" : recipe
            ].replaceAll(
              "__DEMO_ASSET_BASE__",
              `/api/${encodeURIComponent(ctx.organization!.slug!)}/demo/assets`,
            )
          : changePage(bundle, recipe),
      );
    });
  }
  return app;
}
