import { useQuery } from "@tanstack/react-query";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";

export interface ResolvedConnectionForUser {
  connectionId: string | null;
  access: "user" | "org" | null;
}

/**
 * Resolves the caller's own connection for the given app via the
 * CONNECTION_RESOLVE_FOR_USER tool. Prefers a user-private connection,
 * falls back to an org-shared connection.
 *
 * This is the privacy-safe replacement for `useConnections({ slug })` in
 * flows that touch per-user installations (e.g. mcp-github): listing all
 * org connections could surface a teammate's connection and end up showing
 * their personal installations to other users. CONNECTION_RESOLVE_FOR_USER
 * applies per-user filtering server-side.
 *
 * Keep this hook as the single entry point so the query key and response
 * parsing stay in sync across call sites; drift here is a privacy bug.
 */
export function useResolveConnectionForUser(
  orgId: string,
  orgSlug: string,
  appId: string,
) {
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
    orgSlug,
  });

  return useQuery({
    queryKey: KEYS.connectionResolveForUser(orgId, appId),
    queryFn: async (): Promise<ResolvedConnectionForUser> => {
      const result = await selfClient.callTool({
        name: "CONNECTION_RESOLVE_FOR_USER",
        arguments: { app_id: appId },
      });
      const structured = (result as { structuredContent?: unknown })
        .structuredContent;
      const text = (result as { content?: Array<{ text?: string }> })
        .content?.[0]?.text;
      const payload = (structured ??
        (text ? JSON.parse(text) : null)) as ResolvedConnectionForUser | null;
      return payload ?? { connectionId: null, access: null };
    },
  });
}
