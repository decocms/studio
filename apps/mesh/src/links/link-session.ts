import { encodeSubjectToken } from "@decocms/tunnel/subject";
import { z } from "zod";
import { buildUserTunnelHostname } from "./tunnel-host";

export { buildUserTunnelHostname };

export interface LinkSessionPermissions {
  subscribe: {
    allow: string[];
  };
  publish: {
    allow: string[];
  };
}

export interface BuildLinkSessionResponseInput {
  publicUrl: string;
  userId: string;
  ttlSeconds: number;
  credentials?: string;
  token?: string;
}

export const linkSessionResponseSchema = z.object({
  connection: z.object({
    urls: z.array(z.string().min(1)).min(1),
    credentials: z.string().optional(),
    token: z.string().optional(),
  }),
  expiresAt: z.string().min(1),
  tunnelHostname: z.string().min(1),
});

export type LinkSessionResponse = z.infer<typeof linkSessionResponseSchema>;

export function buildDaemonCredentialPermissions(
  tunnelHostname: string,
): LinkSessionPermissions {
  const hostToken = encodeSubjectToken(tunnelHostname);
  const hostPrefix = `tunnel.v1.host.${hostToken}`;

  return {
    subscribe: {
      allow: [
        `${hostPrefix}.request`,
        `${hostPrefix}.req.*.body`,
        `${hostPrefix}.req.*.abort`,
        // Per-daemon request/reply inbox. JetStream `publish()` (used by the
        // direct-NATS chunk relay) awaits a PubAck delivered on a reply inbox,
        // so the daemon must be able to subscribe to its own inbox. Scoped to
        // this host's token (NOT `_INBOX.>`) so one daemon cannot read another
        // tenant's replies — the daemon sets a matching `inboxPrefix`.
        `_INBOX.${hostToken}.>`,
      ],
    },
    publish: {
      allow: [`${hostPrefix}.req.*.reply`, "decopilot.stream.*"],
    },
  };
}

export function buildLinkSessionResponse({
  publicUrl,
  userId,
  ttlSeconds,
  credentials,
  token,
}: BuildLinkSessionResponseInput): LinkSessionResponse {
  return {
    connection: {
      urls: publicUrl
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean),
      ...(credentials ? { credentials } : {}),
      ...(token ? { token } : {}),
    },
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    tunnelHostname: buildUserTunnelHostname(userId),
  };
}
