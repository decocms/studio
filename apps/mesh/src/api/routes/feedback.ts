import { Hono } from "hono";
import type { Env } from "../hono-env";

/**
 * A single piece of user-submitted feedback, handed to the configured
 * {@link FeedbackSink}. `message` is free-text typed by the user, so it may
 * contain anything — treat it as untrusted, user-owned content.
 */
export interface FeedbackEntry {
  message: string;
  orgId: string | undefined;
  userId: string | undefined;
}

/**
 * Where feedback messages go. Studio does NOT decide this for you — the free
 * text a user types is yours to route wherever fits your deployment. Provide
 * your own sink when mounting the routes to send it to Linear, Slack, a
 * database table, an email, a webhook, etc.
 *
 * @example
 * createFeedbackRoutes(async ({ message, orgId, userId }) => {
 *   await fetch("https://hooks.slack.com/services/...", {
 *     method: "POST",
 *     body: JSON.stringify({ text: `Feedback (${orgId}): ${message}` }),
 *   });
 * });
 *
 * The default sink (below) only emits a structured log line — fine for getting
 * started, but replace it once you've decided where feedback should live.
 */
export type FeedbackSink = (entry: FeedbackEntry) => void | Promise<void>;

/**
 * Default sink: structured log line. Intentionally minimal — swap it for a
 * real destination by passing your own {@link FeedbackSink}.
 */
export const logFeedbackSink: FeedbackSink = (entry) => {
  console.log(
    JSON.stringify({
      event: "user_feedback",
      org_id: entry.orgId,
      user_id: entry.userId,
      message: entry.message,
    }),
  );
};

export function createFeedbackRoutes(sink: FeedbackSink = logFeedbackSink) {
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

    await sink({
      message,
      orgId: mesh.organization?.id,
      userId: mesh.auth.user?.id,
    });

    return c.json({ ok: true });
  });

  return app;
}
