/**
 * Channels Collection Hooks
 *
 * React Query hooks for the org's chat-channel integrations (Teams, Discord),
 * backed by the self-MCP CHANNEL_* tools. Mirrors use-ai-providers.ts.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  useQuery,
  useSuspenseQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { KEYS } from "../../lib/query-keys";

export type ChannelType = "whatsapp";
export type ChannelStatus = "draft" | "active" | "error" | "disabled";

export interface ChannelSetupStep {
  title: string;
  description: string;
  link?: { label: string; url: string };
}

export interface ChannelPlatform {
  id: ChannelType;
  name: string;
  description: string;
  logo?: string;
  setupInstructions: ChannelSetupStep[];
}

export interface ChannelInstance {
  id: string;
  channelType: ChannelType;
  label: string;
  agentId: string | null;
  status: ChannelStatus;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentOption {
  id: string;
  title: string;
}

function useSelfClient() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  return { org, client };
}

/** Static registry of supported channel platforms + their setup metadata. */
export function useChannelPlatforms(): ChannelPlatform[] {
  const { org, client } = useSelfClient();
  const { data } = useSuspenseQuery({
    queryKey: KEYS.channelPlatforms(org.id),
    staleTime: Infinity,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "CHANNELS_LIST",
        arguments: {},
      })) as { structuredContent?: { platforms: ChannelPlatform[] } };
      return result.structuredContent?.platforms ?? [];
    },
  });
  return data;
}

/** The org's configured channels (drafts + active). */
export function useOrgChannels(): ChannelInstance[] {
  const { org, client } = useSelfClient();
  const { data } = useSuspenseQuery({
    queryKey: KEYS.orgChannels(org.id),
    staleTime: 30_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "CHANNEL_LIST",
        arguments: {},
      })) as { structuredContent?: { channels: ChannelInstance[] } };
      return result.structuredContent?.channels ?? [];
    },
  });
  return data;
}

/** Connections offered as agent bindings (their id doubles as the agent id). */
export function useAgentOptions(): AgentOption[] {
  const { org, client } = useSelfClient();
  const { data } = useQuery({
    queryKey: KEYS.channelAgentOptions(org.id),
    staleTime: 60_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "COLLECTION_CONNECTIONS_LIST",
        arguments: {
          include_virtual: true,
          limit: 100,
          orderBy: [{ field: ["updated_at"], direction: "desc" }],
        },
      })) as {
        structuredContent?: { items?: Array<{ id: string; title?: string }> };
      };
      return (result.structuredContent?.items ?? []).map((c) => ({
        id: c.id,
        title: c.title ?? c.id,
      }));
    },
  });
  return data ?? [];
}

export function useChannelClient() {
  return useSelfClient();
}

export function invalidateChannels(queryClient: QueryClient, orgId: string) {
  queryClient.invalidateQueries({ queryKey: KEYS.orgChannels(orgId) });
  queryClient.invalidateQueries({ queryKey: KEYS.channelPlatforms(orgId) });
}

// ---------------------------------------------------------------------------
// WhatsApp phone linking (profile)
// ---------------------------------------------------------------------------

export interface UserPhoneState {
  configured: boolean;
  status: "none" | "pending" | "verified";
  code?: string;
  conciergeNumber?: string;
  maskedPhone?: string;
  selectedOrganizationId?: string | null;
}

/**
 * Poll the caller's WhatsApp link status. While `pending`, refetch every few
 * seconds so the UI flips to `verified` once the user's code arrives via the
 * ingest route (effect-free — driven by `refetchInterval`).
 */
export function useUserPhone(userId: string) {
  const { client } = useSelfClient();
  return useQuery({
    queryKey: KEYS.userPhone(userId),
    staleTime: 10_000,
    refetchInterval: (q) =>
      (q.state.data as UserPhoneState | undefined)?.status === "pending"
        ? 3000
        : false,
    queryFn: async (): Promise<UserPhoneState> => {
      const result = (await client.callTool({
        name: "PHONE_GET",
        arguments: {},
      })) as { structuredContent?: UserPhoneState };
      return result.structuredContent ?? { configured: false, status: "none" };
    },
  });
}
