/**
 * Persist OAuth tokens and scope GitHub connections to a single repository.
 */

import type { ConnectionEntity } from "@decocms/mesh-sdk";
import {
  encodeMeshOAuthClientState,
  getGithubConnectionRepoScope,
} from "@/shared/github-connection";

export interface PersistOAuthTokenInput {
  orgSlug: string;
  connectionId: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  scope?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  tokenEndpoint?: string | null;
}

export async function persistDownstreamOAuthToken(
  input: PersistOAuthTokenInput,
): Promise<void> {
  const response = await fetch(
    `/api/${input.orgSlug}/connections/${input.connectionId}/oauth-token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresIn: input.expiresIn,
        scope: input.scope,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        tokenEndpoint: input.tokenEndpoint,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to persist OAuth token: ${response.status}`);
  }
}

type GithubMcpClient = {
  callTool: (...args: unknown[]) => Promise<unknown>;
};

function parseScopeTokenResult(result: unknown): {
  access_token: string;
  expires_in?: number;
} {
  const typed = result as {
    structuredContent?: { access_token?: string; expires_in?: number };
    content?: Array<{ text?: string }>;
  };

  if (typed.structuredContent?.access_token) {
    return {
      access_token: typed.structuredContent.access_token,
      expires_in: typed.structuredContent.expires_in,
    };
  }

  const content = typed.content?.[0]?.text;
  if (content) {
    const parsed = JSON.parse(content) as {
      access_token?: string;
      expires_in?: number;
    };
    if (parsed.access_token) {
      return {
        access_token: parsed.access_token,
        expires_in: parsed.expires_in,
      };
    }
  }

  throw new Error("GITHUB_SCOPE_TOKEN did not return access_token");
}

export async function scopeGithubConnectionToRepository(params: {
  githubClient: GithubMcpClient;
  orgSlug: string;
  connectionId: string;
  repositoryId: number;
  target: string;
  existingTokenInfo?: {
    refreshToken?: string | null;
    clientId?: string | null;
    clientSecret?: string | null;
    tokenEndpoint?: string | null;
    scope?: string | null;
  };
}): Promise<void> {
  const result = await params.githubClient.callTool({
    name: "GITHUB_SCOPE_TOKEN",
    arguments: {
      repository_id: params.repositoryId,
      target: params.target,
    },
  });

  const parsed = parseScopeTokenResult(result);

  await persistDownstreamOAuthToken({
    orgSlug: params.orgSlug,
    connectionId: params.connectionId,
    accessToken: parsed.access_token,
    refreshToken: params.existingTokenInfo?.refreshToken,
    expiresIn: parsed.expires_in ?? null,
    scope: params.existingTokenInfo?.scope ?? null,
    clientId: params.existingTokenInfo?.clientId,
    clientSecret: params.existingTokenInfo?.clientSecret,
    tokenEndpoint: params.existingTokenInfo?.tokenEndpoint,
  });
}

export function connectionHasRepoScopedToken(
  connection: ConnectionEntity | null | undefined,
): boolean {
  return getGithubConnectionRepoScope(connection?.metadata ?? null) !== null;
}

export { encodeMeshOAuthClientState };
