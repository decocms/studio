import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";
import type {
  ChannelAdapter,
  ChannelInboundMessage,
  ParsedInbound,
} from "../types";

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Credentials for a Discord application + bot. `publicKey` verifies inbound
 * interaction signatures; `botToken` authorizes outbound REST calls;
 * `applicationId` addresses interaction follow-ups.
 */
export const discordCredentialSchema = z.object({
  applicationId: z.string().min(1),
  publicKey: z.string().min(1),
  botToken: z.string().min(1),
});

type DiscordCredentials = z.infer<typeof discordCredentialSchema>;

// Discord interaction types (subset).
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
// Interaction response types (subset).
const RESPONSE_PONG = 1;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;

// SPKI DER prefix for an Ed25519 public key (RFC 8410). Prepending this to the
// raw 32-byte key lets node:crypto build a verifiable public KeyObject without
// pulling in tweetnacl or relying on Web Crypto Ed25519 support.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519PublicKeyFromHex(hex: string) {
  const raw = Buffer.from(hex, "hex");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

interface DiscordInteraction {
  type: number;
  id?: string;
  token?: string;
  application_id?: string;
  channel_id?: string;
  member?: { user?: { id?: string; username?: string; global_name?: string } };
  user?: { id?: string; username?: string; global_name?: string };
  data?: {
    name?: string;
    options?: Array<{ name: string; value?: unknown; type?: number }>;
  };
}

function extractCommandText(data: DiscordInteraction["data"]): string {
  if (!data?.options?.length) return "";
  // Accept the first string option, preferring conventionally-named ones.
  const preferred = data.options.find((o) =>
    ["message", "prompt", "text", "ask", "query"].includes(o.name),
  );
  const opt = preferred ?? data.options[0];
  return typeof opt?.value === "string" ? opt.value : "";
}

export const discordAdapter: ChannelAdapter = {
  info: {
    id: "discord",
    name: "Discord",
    description:
      "Let a Discord bot answer slash commands by running a Decopilot agent in this organization.",
    logo: "discord",
  },

  credentialSchema: discordCredentialSchema,

  credentialFields: [
    {
      key: "applicationId",
      label: "Application ID",
      placeholder: "1234567890",
      help: "Found under General Information in the Discord Developer Portal.",
    },
    {
      key: "publicKey",
      label: "Public Key",
      placeholder: "abcdef0123...",
      help: "Used to verify Discord's request signatures.",
    },
    {
      key: "botToken",
      label: "Bot Token",
      secret: true,
      help: "Bot → Reset Token. Stored encrypted; only the last 4 chars are shown after saving.",
    },
  ],

  setupInstructions: [
    {
      title: "Create a Discord application",
      description:
        "In the Discord Developer Portal, create a New Application, then open the Bot tab and Reset Token to reveal the bot token. Copy the Application ID and Public Key from General Information.",
      link: {
        label: "Open Discord Developer Portal",
        url: "https://discord.com/developers/applications",
      },
    },
    {
      title: "Set the Interactions Endpoint URL",
      description:
        "Paste the endpoint URL below into General Information → Interactions Endpoint URL and save. Discord sends a verification PING when you save — keep this wizard open so the endpoint can answer it.",
    },
    {
      title: "Register a command & invite the bot",
      description:
        "Add a slash command (e.g. /ask with a text option) and invite the bot to your server using an OAuth2 URL with the bot and applications.commands scopes.",
    },
  ],

  async verifySignature({ rawBody, headers, credentials }) {
    const creds = credentials as DiscordCredentials;
    const signature = headers.get("x-signature-ed25519");
    const timestamp = headers.get("x-signature-timestamp");
    if (!signature || !timestamp || !creds.publicKey) return false;
    try {
      const key = ed25519PublicKeyFromHex(creds.publicKey);
      const data = Buffer.concat([
        Buffer.from(timestamp, "utf8"),
        Buffer.from(new Uint8Array(rawBody)),
      ]);
      return cryptoVerify(null, data, key, Buffer.from(signature, "hex"));
    } catch {
      return false;
    }
  },

  parseInbound(payload): ParsedInbound {
    const interaction = payload as DiscordInteraction;

    if (interaction.type === INTERACTION_PING) {
      return { kind: "ack", response: { type: RESPONSE_PONG } };
    }

    if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
      const text = extractCommandText(interaction.data);
      const user = interaction.member?.user ?? interaction.user;
      const message: ChannelInboundMessage = {
        senderId: user?.id ?? "unknown",
        senderName: user?.global_name ?? user?.username ?? "Discord user",
        text,
        conversationKey: interaction.channel_id ?? user?.id ?? "discord",
        conversationRef: {
          applicationId: interaction.application_id ?? "",
          interactionToken: interaction.token ?? "",
          channelId: interaction.channel_id ?? "",
        },
      };
      // Defer: Discord requires a response within 3s; the agent run is slower,
      // so we acknowledge with a "thinking..." deferred reply and post the real
      // answer as a follow-up.
      return {
        kind: "message",
        message,
        ackResponse: { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE },
      };
    }

    // Components, autocomplete, modals, etc. — acknowledge without acting.
    return { kind: "ack", response: { type: RESPONSE_PONG } };
  },

  async sendOutbound({ credentials, conversationRef, text }) {
    const creds = credentials as DiscordCredentials;
    const applicationId =
      (conversationRef.applicationId as string) || creds.applicationId;
    const interactionToken = conversationRef.interactionToken as
      | string
      | undefined;

    if (interactionToken) {
      // Follow-up to a deferred interaction response.
      const res = await fetch(
        `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: truncateForDiscord(text) }),
        },
      );
      if (!res.ok) {
        throw new Error(
          `Discord follow-up failed: ${res.status} ${await safeText(res)}`,
        );
      }
      return;
    }

    // Fallback: post directly to a channel with the bot token.
    const channelId = conversationRef.channelId as string | undefined;
    if (!channelId) throw new Error("Discord: no conversation reference");
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bot ${creds.botToken}`,
      },
      body: JSON.stringify({ content: truncateForDiscord(text) }),
    });
    if (!res.ok) {
      throw new Error(
        `Discord message failed: ${res.status} ${await safeText(res)}`,
      );
    }
  },

  async testConnection(credentials) {
    const creds = credentials as DiscordCredentials;
    try {
      const res = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { authorization: `Bot ${creds.botToken}` },
      });
      if (!res.ok) {
        return {
          ok: false,
          detail: `Discord rejected the bot token (${res.status}).`,
        };
      }
      const me = (await res.json()) as { username?: string };
      return { ok: true, botDisplayName: me.username };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : "Connection failed",
      };
    }
  },

  maskCredentials(credentials) {
    const creds = credentials as Partial<DiscordCredentials>;
    return {
      applicationId: creds.applicationId ?? "",
      publicKey: creds.publicKey ? maskTail(creds.publicKey) : "",
      botToken: creds.botToken ? maskTail(creds.botToken) : "",
    };
  },
};

// Discord message content cap is 2000 chars.
function truncateForDiscord(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

function maskTail(value: string): string {
  return value.length > 4 ? `${"•".repeat(8)}${value.slice(-4)}` : "••••••••";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
