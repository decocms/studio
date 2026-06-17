import { encodeSubjectToken } from "@decocms/tunnel/subject";
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

export interface LinkSessionResponse {
  connection: {
    urls: string[];
    credentials?: string;
    token?: string;
  };
  expiresAt: string;
  tunnelHostname: string;
}

export function buildDaemonCredentialPermissions(
  tunnelHostname: string,
): LinkSessionPermissions {
  const hostToken = encodeSubjectToken(tunnelHostname);
  const hostPrefix = `_tunnel.v1.host.${hostToken}`;

  return {
    subscribe: {
      allow: [
        `${hostPrefix}.request`,
        `${hostPrefix}.req.*.body`,
        `${hostPrefix}.req.*.abort`,
      ],
    },
    publish: {
      allow: [`${hostPrefix}.req.*.reply`],
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
