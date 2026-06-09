import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type {
  ChannelAdapter,
  ChannelInboundMessage,
  ParsedInbound,
} from "../types";

/**
 * Credentials for a Microsoft Teams bot (Azure Bot Service / Bot Framework).
 * `appId` + `appPassword` are the bot's Microsoft App registration client id
 * and secret; `tenantId` is optional (single-tenant bots).
 */
export const teamsCredentialSchema = z.object({
  appId: z.string().min(1),
  appPassword: z.string().min(1),
  tenantId: z.string().optional(),
});

type TeamsCredentials = z.infer<typeof teamsCredentialSchema>;

// Bot Framework token issuer + JWKS for inbound Activity authentication.
const BOTFRAMEWORK_ISSUER = "https://api.botframework.com";
const BOTFRAMEWORK_JWKS = createRemoteJWKSet(
  new URL("https://login.botframework.com/v1/keys"),
);
const BOTFRAMEWORK_TOKEN_URL =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const BOTFRAMEWORK_SCOPE = "https://api.botframework.com/.default";

interface TeamsActivity {
  type?: string;
  text?: string;
  serviceUrl?: string;
  from?: { id?: string; name?: string };
  conversation?: { id?: string };
  recipient?: { id?: string; name?: string };
}

// Cache of client-credentials tokens keyed by appId. Bot Framework tokens last
// ~1h; we refresh a minute early. Module-level so replies don't re-mint per call.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getBotToken(creds: TeamsCredentials): Promise<string> {
  const cached = tokenCache.get(creds.appId);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.appId,
    client_secret: creds.appPassword,
    scope: BOTFRAMEWORK_SCOPE,
  });
  const res = await fetch(BOTFRAMEWORK_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Teams token request failed: ${res.status} ${await safeText(res)}`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };
  const expiresAt = now + (json.expires_in ?? 3600) * 1000;
  tokenCache.set(creds.appId, { token: json.access_token, expiresAt });
  return json.access_token;
}

export const teamsAdapter: ChannelAdapter = {
  info: {
    id: "teams",
    name: "Microsoft Teams",
    description:
      "Let a Microsoft Teams bot answer messages by running a Decopilot agent in this organization.",
    logo: "teams",
  },

  credentialSchema: teamsCredentialSchema,

  credentialFields: [
    {
      key: "appId",
      label: "Microsoft App ID",
      placeholder: "00000000-0000-0000-0000-000000000000",
      help: "The Azure Bot's Microsoft App ID.",
    },
    {
      key: "appPassword",
      label: "Client secret",
      secret: true,
      help: "A client secret you created for the bot's App registration.",
    },
    {
      key: "tenantId",
      label: "Tenant ID",
      optional: true,
      placeholder: "(single-tenant bots only)",
    },
  ],

  setupInstructions: [
    {
      title: "Create an Azure Bot",
      description:
        "In the Azure Portal, create an Azure Bot resource. Note its Microsoft App ID and create a client secret under the App registration's Certificates & secrets.",
      link: {
        label: "Open Azure Portal",
        url: "https://portal.azure.com/#create/Microsoft.AzureBot",
      },
    },
    {
      title: "Set the Messaging endpoint",
      description:
        "Paste the endpoint URL below into the Azure Bot's Configuration → Messaging endpoint and save.",
    },
    {
      title: "Add the Teams channel",
      description:
        "Under Channels, add Microsoft Teams, then install/side-load the bot into your team or chat to start messaging it.",
    },
  ],

  async verifySignature({ headers, credentials }) {
    const creds = credentials as TeamsCredentials;
    const authz = headers.get("authorization");
    const token = authz?.startsWith("Bearer ") ? authz.slice(7).trim() : null;
    if (!token) return false;
    try {
      await jwtVerify(token, BOTFRAMEWORK_JWKS, {
        issuer: BOTFRAMEWORK_ISSUER,
        audience: creds.appId,
      });
      return true;
    } catch {
      return false;
    }
  },

  parseInbound(payload): ParsedInbound {
    const activity = payload as TeamsActivity;
    if (activity.type !== "message" || !activity.text) {
      // conversationUpdate, typing, etc. — acknowledge with a bare 200.
      return { kind: "ack" };
    }
    const message: ChannelInboundMessage = {
      senderId: activity.from?.id ?? "unknown",
      senderName: activity.from?.name ?? "Teams user",
      text: activity.text,
      conversationKey:
        activity.conversation?.id ?? activity.from?.id ?? "teams",
      conversationRef: {
        serviceUrl: activity.serviceUrl ?? "",
        conversationId: activity.conversation?.id ?? "",
      },
    };
    // Teams tolerates a bare 200 ACK followed by a proactive activity, so we
    // don't return an inline reply body.
    return { kind: "message", message };
  },

  async sendOutbound({ credentials, conversationRef, text }) {
    const creds = credentials as TeamsCredentials;
    const serviceUrl = conversationRef.serviceUrl as string | undefined;
    const conversationId = conversationRef.conversationId as string | undefined;
    if (!serviceUrl || !conversationId) {
      throw new Error("Teams: incomplete conversation reference");
    }
    const token = await getBotToken(creds);
    const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(
      conversationId,
    )}/activities`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type: "message", text }),
    });
    if (!res.ok) {
      throw new Error(
        `Teams reply failed: ${res.status} ${await safeText(res)}`,
      );
    }
  },

  async testConnection(credentials) {
    const creds = credentials as TeamsCredentials;
    try {
      await getBotToken(creds);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        detail:
          err instanceof Error
            ? err.message
            : "Could not authenticate with Bot Framework",
      };
    }
  },

  maskCredentials(credentials) {
    const creds = credentials as Partial<TeamsCredentials>;
    return {
      appId: creds.appId ?? "",
      appPassword: creds.appPassword ? maskTail(creds.appPassword) : "",
      tenantId: creds.tenantId ?? "",
    };
  },
};

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
