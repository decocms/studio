import { Hono } from "hono";
import type { Env } from "../hono-env";

export function createFeedbackRoutes() {
  const app = new Hono<Env>();

  app.post("/feedback", async (c) => {
    const mesh = c.get("meshContext");
    let body: { message?: unknown };
    try {
      body = await c.req.json<{ message?: unknown }>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const message =
      typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return c.json({ error: "message required" }, 400);

    console.log(
      JSON.stringify({
        event: "user_feedback",
        org_id: mesh.organization?.id,
        user_id: mesh.auth.user?.id,
        message,
      }),
    );

    return c.json({ ok: true });
  });

  return app;
}
