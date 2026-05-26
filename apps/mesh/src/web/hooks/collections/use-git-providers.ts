/**
 * Git Provider hooks — thin wrappers around the management MCP tools that
 * power the Settings → Git Providers page.
 *
 * Each hook talks to the org's "self" MCP (the same channel AI Providers use),
 * so the React Query keys are namespaced by org id via the central KEYS map.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { KEYS } from "../../lib/query-keys";

export interface GitProviderInfo {
  id: string;
  name: string;
  description: string;
  logo?: string;
  available: boolean;
}

export interface GitProviderInstallation {
  id: string;
  providerId: string;
  installationId: string;
  accountLogin: string;
  accountId: string;
  accountType: "Organization" | "User";
  repositorySelection: "all" | "selected";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitProviderUserLinkStatus {
  linked: boolean;
  githubAccountId?: string;
  linkUrl: string;
}

function useSelfClient() {
  const { org } = useProjectContext();
  return {
    org,
    client: useMCPClient({
      connectionId: SELF_MCP_ALIAS_ID,
      orgId: org.id,
      orgSlug: org.slug,
    }),
  };
}

export function useGitProviders() {
  const { org, client } = useSelfClient();
  const { data } = useSuspenseQuery({
    queryKey: KEYS.gitProviders(org.id),
    staleTime: Infinity,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "GIT_PROVIDERS_LIST",
        arguments: {},
      })) as { structuredContent?: { providers: GitProviderInfo[] } };
      return result.structuredContent?.providers ?? [];
    },
  });
  return data;
}

export function useGitInstallations() {
  const { org, client } = useSelfClient();
  const { data } = useSuspenseQuery({
    queryKey: KEYS.gitProviderInstallations(org.id),
    staleTime: 60_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "GIT_PROVIDER_INSTALLATION_LIST",
        arguments: {},
      })) as {
        structuredContent?: { installations: GitProviderInstallation[] };
      };
      return result.structuredContent?.installations ?? [];
    },
  });
  return data;
}

export function useGitUserLink(userId: string | undefined) {
  const { org, client } = useSelfClient();
  const { data } = useQuery({
    queryKey: KEYS.gitProviderUserLink(org.id, userId ?? ""),
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "GIT_PROVIDER_USER_LINK_STATUS",
        arguments: { redirectTo: window.location.href },
      })) as { structuredContent?: GitProviderUserLinkStatus };
      return result.structuredContent ?? null;
    },
  });
  return data;
}
