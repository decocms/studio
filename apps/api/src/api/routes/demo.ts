import { Hono } from "hono";
import { DemoRecipeSchema } from "@decocms/shared/demo";
import type { Env } from "../hono-env";
import { storefront, changePage, reportPage } from "@/demo/artifacts";

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
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    return next();
  });
  app.get("/storefront", async (c) => {
    const ctx = c.get("studioContext");
    const published = await ctx.storage.demo.publishedRecipes(
      ctx.organization!.id,
    );
    return c.html(
      storefront(
        "search",
        true,
        `/${encodeURIComponent(ctx.organization!.slug!)}/tasks`,
        published,
      ),
    );
  });
  app.get("/report", (c) =>
    c.html(reportPage(`/${encodeURIComponent(c.req.param("org")!)}/tasks`)),
  );
  for (const kind of ["preview", "changes"] as const) {
    app.get(`/${kind}/:taskId`, async (c) => {
      const ctx = c.get("studioContext");
      const item = await ctx.storage.demo.artifact(
        ctx.organization!.id,
        c.req.param("taskId"),
      );
      if (!item?.delivered) return c.notFound();
      const recipe = DemoRecipeSchema.parse(item.recipe);
      const board = `/${encodeURIComponent(ctx.organization!.slug!)}/tasks`;
      return c.html(
        kind === "preview"
          ? storefront(recipe, c.req.query("before") === "1", board)
          : changePage(
              recipe,
              `../preview/${encodeURIComponent(c.req.param("taskId"))}`,
              board,
            ),
      );
    });
  }
  return app;
}
