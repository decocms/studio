/**
 * Channel Inbound Webhook Endpoints
 *
 * Receives platform callbacks for configured chat channels and drives the
 * conversational loop: verify the platform signature, ACK within the platform
 * deadline, then (asynchronously) run a Decopilot agent turn and post the reply
 * back into the conversation.
 *
 * Routes (mounted under /api/:org by org-scoped.ts):
 *   POST /:channelId/teams
 *   POST /:channelId/discord
 *
 * Auth is per-platform: Discord verifies an Ed25519 signature against the
 * stored public key; Teams verifies the Bot Framework JWT. The :channelId path
 * segment + resolved org locate the channel; the signature authenticates.
 */

import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getChannelAdapter } from "@/channels/registry";
import { runChannelTurn } from "@/channels/run-channel-turn";
import type { ChannelType } from "@/storage/types";
import type { Env } from "../hono-env";

const MAX_BODY_SIZE = 1_048_576; // 1MB

/** Deterministic, stable thread id for a channel conversation. */
function threadIdFor(channelId: string, conversationKey: string): string {
  const hash = createHash("sha1")
    .update(`${channelId}:${conversationKey}`)
    .digest("hex")
    .slice(0, 24);
  return `thrd_chan_${hash}`;
}

export function createChannelWebhookRoutes() {
  const app = new Hono<Env>();

  const limit = bodyLimit({
    maxSize: MAX_BODY_SIZE,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  });

  const handle = async (c: Context<Env>, channelType: ChannelType) => {
    const ctx = c.get("meshContext");
    if (!ctx?.organization) {
      return c.json({ error: "Organization context missing" }, 500);
    }
    const orgId = ctx.organization.id;
    const channelId = c.req.param("channelId");
    if (!channelId) {
      return c.json({ error: "channelId required" }, 400);
    }

    // Load + decrypt the channel credentials (needed for signature verify).
    let resolved: Awaited<ReturnType<typeof ctx.storage.channels.resolve>>;
    try {
      resolved = await ctx.storage.channels.resolve(channelId, orgId);
    } catch {
      return c.json({ error: "Channel not found" }, 404);
    }
    const { info, credentials } = resolved;
    if (info.channelType !== channelType) {
      return c.json({ error: "Channel type mismatch" }, 404);
    }
    if (!credentials) {
      return c.json({ error: "Channel not configured" }, 409);
    }

    const adapter = getChannelAdapter(channelType);

    // Signatures are computed over the raw bytes — read them before parsing.
    const rawBody = await c.req.arrayBuffer();
    const verified = await adapter.verifySignature({
      rawBody,
      headers: c.req.raw.headers,
      credentials,
    });
    if (!verified) {
      return c.json({ error: "Signature verification failed" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      payload = null;
    }

    const parsed = adapter.parseInbound(payload);
    if (parsed.kind === "ack") {
      return parsed.response !== undefined
        ? c.json(parsed.response as object, 200)
        : c.body(null, 200);
    }

    // It's a real message. If the channel isn't fully set up we can't run the
    // agent — acknowledge so the platform doesn't retry, and stop.
    const agentId = info.agentId;
    if (!agentId) {
      console.warn(
        `[channel-webhook] channel ${channelId} has no agent bound — skipping`,
      );
      return ackResponse(c, parsed.ackResponse);
    }

    // Teams/Discord channels always have a synthetic bot member; the agent runs
    // as that bot. (WhatsApp — which has no bot — uses the global ingest route,
    // not this per-org webhook.)
    const botUserId = info.botUserId;
    if (!botUserId) {
      console.warn(
        `[channel-webhook] channel ${channelId} has no bot user — skipping`,
      );
      return ackResponse(c, parsed.ackResponse);
    }

    const { message } = parsed;
    const threadId = threadIdFor(channelId, message.conversationKey);

    // Run the agent turn AFTER acking (platform deadlines are short; the agent
    // loop can take minutes). Fire-and-forget with error logging + best-effort
    // error reply, mirroring the automation dispatch fire-and-forget pattern.
    void (async () => {
      try {
        const { replyText } = await runChannelTurn({
          organizationId: orgId,
          userId: botUserId,
          agentId,
          threadId,
          userText: message.text,
          sender: {
            platform: channelType,
            senderId: message.senderId,
            senderName: message.senderName,
          },
        });
        await adapter.sendOutbound({
          credentials,
          conversationRef: message.conversationRef,
          text:
            replyText ||
            "I wasn't able to produce a response. Please try again.",
        });
      } catch (err) {
        console.error(
          `[channel-webhook] turn failed for channel ${channelId}:`,
          err instanceof Error ? err.message : err,
        );
        try {
          await adapter.sendOutbound({
            credentials,
            conversationRef: message.conversationRef,
            text: "Something went wrong while handling your message.",
          });
        } catch {
          // best-effort
        }
      }
    })();

    return ackResponse(c, parsed.ackResponse);
  };

  app.post("/:channelId/teams", limit, (c) => handle(c, "teams"));
  app.post("/:channelId/discord", limit, (c) => handle(c, "discord"));

  return app;
}

function ackResponse(c: Context<Env>, response: unknown) {
  return response !== undefined
    ? c.json(response as object, 200)
    : c.body(null, 200);
}
