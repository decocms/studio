import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../hono-env";

/** Max JSON body size for feedback POSTs. */
const FEEDBACK_MAX_BODY_SIZE = 65_536;

/** Max length for free-text fields after trim. */
export const FEEDBACK_MAX_TEXT_LENGTH = 16_384;

/** Default sink log preview — avoids dumping multi-KB secrets into stdout. */
const FEEDBACK_LOG_PREVIEW_LENGTH = 500;

export type FeedbackKind = "general" | "chat_negative";

/**
 * A single piece of user-submitted feedback, handed to the configured
 * {@link FeedbackSink}. Free-text fields may contain anything — treat as
 * untrusted, user-owned content.
 */
export interface FeedbackEntry {
  kind: FeedbackKind;
  /** General: user message. Chat negative: optional details only. */
  message: string;
  orgId: string | undefined;
  userId: string | undefined;
  messageId?: string;
  threadId?: string | null;
  reasons?: string[];
}

/**
 * Where feedback messages go. Studio does NOT decide this for you — provide
 * your own sink when mounting the routes (Linear, Slack, DB, webhook, etc.).
 */
export type FeedbackSink = (entry: FeedbackEntry) => void | Promise<void>;

export function truncateForLog(
  text: string,
  max = FEEDBACK_LOG_PREVIEW_LENGTH,
): {
  preview: string;
  truncated: boolean;
} {
  if (text.length <= max) return { preview: text, truncated: false };
  return { preview: `${text.slice(0, max)}…`, truncated: true };
}

/**
 * Default sink: structured log line. Intentionally minimal — swap it for a
 * real destination by passing your own {@link FeedbackSink}.
 */
const logFeedbackSink: FeedbackSink = (entry) => {
  const { preview, truncated } = truncateForLog(entry.message);
  console.log(
    JSON.stringify({
      event:
        entry.kind === "chat_negative"
          ? "chat_message_feedback_negative"
          : "user_feedback",
      org_id: entry.orgId,
      user_id: entry.userId,
      message_id: entry.messageId,
      thread_id: entry.threadId,
      reasons: entry.reasons,
      message: preview,
      message_truncated: truncated,
    }),
  );
};

type FeedbackBody = {
  kind?: unknown;
  message?: unknown;
  messageId?: unknown;
  threadId?: unknown;
  reasons?: unknown;
  details?: unknown;
};

function parseString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function parseReasons(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const reasons: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 200) continue;
    reasons.push(trimmed);
  }
  return reasons;
}

export function parseFeedbackBody(
  body: FeedbackBody,
):
  | { ok: true; entry: Omit<FeedbackEntry, "orgId" | "userId"> }
  | { ok: false; error: string } {
  const kind = body.kind === "chat_negative" ? "chat_negative" : "general";

  if (kind === "general") {
    const message = parseString(body.message, FEEDBACK_MAX_TEXT_LENGTH);
    if (!message) return { ok: false, error: "message required" };
    return { ok: true, entry: { kind: "general", message } };
  }

  const messageId = parseString(body.messageId, 128);
  if (!messageId) return { ok: false, error: "messageId required" };

  const details =
    typeof body.details === "string"
      ? body.details.trim().slice(0, FEEDBACK_MAX_TEXT_LENGTH)
      : "";
  const reasons = parseReasons(body.reasons) ?? [];

  if (reasons.length === 0 && !details) {
    return { ok: false, error: "reasons or details required" };
  }

  const threadId =
    body.threadId === null || body.threadId === undefined
      ? null
      : parseString(body.threadId, 128);

  return {
    ok: true,
    entry: {
      kind: "chat_negative",
      message: details,
      messageId,
      threadId,
      reasons: reasons.length > 0 ? reasons : undefined,
    },
  };
}

export function createFeedbackRoutes(sink: FeedbackSink = logFeedbackSink) {
  const app = new Hono<Env>();

  app.post(
    "/feedback",
    bodyLimit({
      maxSize: FEEDBACK_MAX_BODY_SIZE,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
    async (c) => {
      const mesh = c.get("meshContext");
      const userId = mesh.auth.user?.id ?? mesh.auth.apiKey?.userId;
      if (!userId) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const orgId = mesh.organization?.id;
      if (!orgId) {
        return c.json({ error: "Organization required" }, 400);
      }

      let body: FeedbackBody;
      try {
        body = await c.req.json<FeedbackBody>();
      } catch {
        return c.json({ error: "invalid JSON" }, 400);
      }

      const parsed = parseFeedbackBody(body);
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, 400);
      }

      try {
        await sink({
          ...parsed.entry,
          orgId,
          userId,
        });
      } catch (err) {
        console.error("[feedback] sink failed:", err);
        return c.json({ error: "Failed to record feedback" }, 502);
      }

      return c.json({ ok: true });
    },
  );

  return app;
}
