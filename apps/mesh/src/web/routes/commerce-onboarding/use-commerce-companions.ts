import { KEYS } from "@/web/lib/query-keys";
import { callRegistryTool } from "@/web/utils/registry-utils";
import { useMCPClient, WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useQueries, useQuery } from "@tanstack/react-query";
import { COMMERCE_COMPANION_MCPS } from "./companions.ts";
import {
  buildCompanionCards,
  buildRegistryWhere,
  parseBindingRequirements,
  unwrapToolResult,
  type CandidateConnection,
  type CompanionCardModel,
  type RegistryItemLike,
} from "./companions-core.ts";

interface CompanionOrg {
  id: string;
  slug: string;
}

type ConnectionWhereCondition = {
  field: string[];
  operator: "in";
  value: string[];
};

export function useCommerceCompanions({
  selfClient,
  org,
  cdConnectionId,
}: {
  selfClient: Client;
  org: CompanionOrg;
  cdConnectionId: string;
}): { cards: CompanionCardModel[]; isLoading: boolean; error: unknown } {
  // 1) CD's live config schema (on the CD connection's OWN client).
  const cdClient = useMCPClient({
    connectionId: cdConnectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const schemaQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionSchema(org.id, cdConnectionId),
    queryFn: async () => {
      const result = await cdClient.callTool({
        name: "MCP_CONFIGURATION",
        arguments: {},
      });
      return unwrapToolResult<{ stateSchema?: Record<string, unknown> }>(
        result,
      );
    },
  });

  const requirements = parseBindingRequirements(
    schemaQuery.data?.stateSchema ?? { type: "object", properties: {} },
  );
  const bindingTypes = requirements.map((r) => r.bindingType);
  const registryAppIds = requirements
    .map((r) => COMMERCE_COMPANION_MCPS[r.bindingType]?.registryAppId)
    .filter((v): v is string => !!v);
  const nameOnly = requirements
    .filter((r) => !COMMERCE_COMPANION_MCPS[r.bindingType])
    .map((r) => r.bindingType);
  const registryKey = [...registryAppIds, ...nameOnly].sort().join(",");

  // 2) CD saved state (shared cache key with the parent connection query).
  const cdConnectionQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryConnection(org.id, cdConnectionId),
    queryFn: async () => {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: cdConnectionId },
      });
      return unwrapToolResult<{
        item: { configuration_state?: Record<string, unknown> | null } | null;
      }>(result);
    },
  });
  const configurationState =
    cdConnectionQuery.data?.item?.configuration_state ?? null;
  const linkedConnectionIds = requirements
    .map(
      (r) =>
        (configurationState?.[r.fieldKey] as { value?: unknown } | undefined)
          ?.value,
    )
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  // 3) Existing org connections that could satisfy a binding (app identity).
  const connectionsQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionConnections(org.id),
    enabled: requirements.length > 0,
    queryFn: async () => {
      const conditions: ConnectionWhereCondition[] = [
        { field: ["app_name"], operator: "in", value: bindingTypes },
        { field: ["app_id"], operator: "in", value: registryAppIds },
      ];
      if (linkedConnectionIds.length > 0) {
        conditions.push({
          field: ["id"],
          operator: "in",
          value: linkedConnectionIds,
        });
      }
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_LIST",
        arguments: {
          where: {
            operator: "or",
            conditions,
          },
          limit: 1000,
        },
      });
      return unwrapToolResult<{ items: CandidateConnection[] }>(result);
    },
  });
  const connections = connectionsQuery.data?.items ?? [];
  const linkedConnectionIdSet = new Set(linkedConnectionIds);
  const linkedConnections = connections.filter((connection) =>
    linkedConnectionIdSet.has(connection.id),
  );
  const oauthStatusConnections = linkedConnections.filter(
    (connection) => connection.oauth_config && !connection.connection_token,
  );
  const oauthStatusQueries = useQueries({
    queries: oauthStatusConnections.map((connection) => ({
      queryKey: KEYS.commerceDiscoveryCompanionOAuthStatus(
        org.id,
        connection.id,
      ),
      queryFn: async () => {
        const response = await fetch(
          `/api/${encodeURIComponent(org.slug)}/connections/${encodeURIComponent(connection.id)}/oauth-token/status`,
          { credentials: "include" },
        );
        if (!response.ok) return { hasToken: false };
        const data = (await response.json()) as { hasToken?: unknown };
        return { hasToken: data.hasToken === true };
      },
      retry: false,
    })),
  });
  const oauthStatusByConnectionId = new Map(
    oauthStatusConnections.map((connection, index) => [
      connection.id,
      oauthStatusQueries[index]?.data?.hasToken === true,
    ]),
  );
  const connectionReadiness: Record<string, boolean> = {};
  for (const connection of linkedConnections) {
    connectionReadiness[connection.id] =
      !connection.oauth_config ||
      !!connection.connection_token ||
      oauthStatusByConnectionId.get(connection.id) === true;
  }

  // 4) Registry batch (one LIST on the Deco store).
  const registryQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionRegistry(org.id, registryKey),
    enabled: requirements.length > 0,
    queryFn: async () => {
      const where = buildRegistryWhere(registryAppIds, nameOnly);
      const result = await callRegistryTool<{ items: RegistryItemLike[] }>(
        WellKnownOrgMCPId.REGISTRY(org.id),
        org.id,
        org.slug,
        "COLLECTION_REGISTRY_APP_LIST",
        { ...(where ? { where } : {}), limit: 1000 },
      );
      // callRegistryTool doesn't throw on isError; surface it here so the
      // section renders its error state instead of silently gating out.
      return unwrapToolResult<{ items: RegistryItemLike[] }>(result);
    },
  });

  const itemsById: Record<string, RegistryItemLike> = {};
  const itemsByName: Record<string, RegistryItemLike> = {};
  for (const item of registryQuery.data?.items ?? []) {
    itemsById[item.id] = item;
    if (item.server?.name) itemsByName[item.server.name] = item;
  }

  const cards = buildCompanionCards({
    requirements,
    itemsById,
    itemsByName,
    connections,
    connectionReadiness,
    configurationState,
    curated: COMMERCE_COMPANION_MCPS,
  });

  const isLoading =
    schemaQuery.isPending ||
    cdConnectionQuery.isPending ||
    (requirements.length > 0 &&
      (connectionsQuery.isPending ||
        registryQuery.isPending ||
        oauthStatusQueries.some((query) => query.isPending)));
  const error =
    schemaQuery.error ??
    cdConnectionQuery.error ??
    connectionsQuery.error ??
    registryQuery.error ??
    null;

  return { cards, isLoading, error };
}
