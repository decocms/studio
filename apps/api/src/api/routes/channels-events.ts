/**
 * Channel ingestion: a channel worker pushes normalized events for one
 * connection, authenticated by that connection's own token (`chit_…`). The
 * organization and the connection come from the token, never from the body;
 * the path only has to agree with them.
 *
 *   POST /api/:org/channels/connections/:connectionId/events
 *   Authorization: Bearer chit_<64 hex>
 *   { "events": ChannelEvent[] }  (1..500)
 *   → 200 { "accepted": n }
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { CHANNEL_TOKEN_PREFIX, ChannelEventSchema } from "@/storage/channels";
import { bearerToken } from "./credential-vault";

const MAX_BODY_SIZE = 1_048_576; // 1MB
const TOKEN = new RegExp(`^${CHANNEL_TOKEN_PREFIX}[0-9a-f]{64}$`);

const ChannelEventsBodySchema = z.object({
  events: z.array(ChannelEventSchema).min(1).max(500),
});

export function createChannelEventsRoutes() {
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();

  app.post(
    "/channels/connections/:connectionId/events",
    bodyLimit({
      maxSize: MAX_BODY_SIZE,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
    async (c) => {
      const ctx = c.get("studioContext");
      const token = bearerToken(c.req.header("authorization"));
      const owner =
        token && TOKEN.test(token)
          ? await ctx.storage.channels.connectionForToken(token)
          : null;
      // One answer for every failure: no hint which part was wrong.
      if (
        !owner ||
        owner.id !== c.req.param("connectionId") ||
        owner.organizationId !== ctx.organization?.id
      ) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const parsed = ChannelEventsBodySchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400,
        );
      }

      await ctx.storage.channels.ingest(
        owner.organizationId,
        owner.id,
        parsed.data.events,
      );
      return c.json({ accepted: parsed.data.events.length });
    },
  );

  return app;
}
