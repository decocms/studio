import { KEYS } from "@/lib/query-keys";
import { callRegistryTool } from "@/utils/registry-utils";
import { useMCPClient, WellKnownOrgMCPId } from "@/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  useQuery,
  useSuspenseQueries,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { PROVIDER_BY_BINDING_TYPE } from "./companion-forms/sa-binding-copy.ts";
import { COMMERCE_COMPANION_MCPS } from "./companions.ts";
import {
  buildCompanionCards,
  buildRegistryWhere,
  FALLBACK_COMPANION_REQUIREMENTS,
  parseBindingRequirements,
  type SaBindings,
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

interface ConnectionStatusResult {
  providers?: Record<
    string,
    {
      connected?: boolean;
      via?: "oauth" | "sa" | null;
      resource?: string | null;
    }
  >;
  /** False ⇒ the site isn't claimed for this org, so providers is empty
   *  because the status is unreadable — NOT because nothing is connected. */
  claimed?: boolean;
}

export function useCommerceCompanions({
  selfClient,
  org,
  cdConnectionId,
  siteUrl,
}: {
  selfClient: Client;
  org: CompanionOrg;
  cdConnectionId: string;
  siteUrl?: string;
}): { cards: CompanionCardModel[]; saStatusUnavailable: boolean } {
  // 1) CD's live config schema (on the CD connection's OWN client).
  const cdClient = useMCPClient({
    connectionId: cdConnectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  // Soft (non-suspense) on purpose: this call proxies to the CD origin
  // (commerce-skills) and can 401 when the connection lost its credential. As a
  // hard Suspense dependency, that 401 threw and collapsed the whole section —
  // no cards, no connect, no disconnect. Now a failure just drops us to the
  // static requirements below so the integrations still render.
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
    retry: false,
  });

  const schemaRequirements = schemaQuery.data?.stateSchema
    ? parseBindingRequirements(schemaQuery.data.stateSchema)
    : null;
  // Live schema wins; fall back to the known companion set while it loads or
  // when it's unreachable, so the section is never empty due to a CD proxy 401.
  // Shopify is gated behind an explicit `?shopify` search param while it's
  // being rolled out; without it the card never renders.
  const { shopify: shopifyParam } = useSearch({ strict: false }) as {
    shopify?: unknown;
  };
  const requirements = (
    schemaRequirements && schemaRequirements.length > 0
      ? schemaRequirements
      : FALLBACK_COMPANION_REQUIREMENTS
  ).filter((r) => r.bindingType !== "shopify" || shopifyParam != null);
  const bindingTypes = requirements.map((r) => r.bindingType);
  const registryAppIds = requirements
    .map((r) => COMMERCE_COMPANION_MCPS[r.bindingType]?.registryAppId)
    .filter((v): v is string => !!v);
  const nameOnly = requirements
    .filter((r) => !COMMERCE_COMPANION_MCPS[r.bindingType])
    .map((r) => r.bindingType);
  const registryKey = [...registryAppIds, ...nameOnly].sort().join(",");

  // 2) CD saved state (shared cache key with the parent connection query).
  const cdConnectionQuery = useSuspenseQuery({
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
  // Key includes every input the queryFn reads from the closure so a schema or
  // config-state change (which alters the short-circuit and the WHERE clause)
  // triggers a fresh fetch instead of serving a stale empty/partial result.
  // Each segment is namespaced (binding/app/linked) so the same string in
  // different categories can't collapse into one key and cross-contaminate the
  // cache — these map to distinct WHERE fields (app_name / app_id / id).
  const connectionsKey = [
    ...bindingTypes.map((t) => `binding:${t}`),
    ...registryAppIds.map((a) => `app:${a}`),
    ...linkedConnectionIds.map((id) => `linked:${id}`),
  ]
    .sort()
    .join(",");
  const connectionsQuery = useSuspenseQuery({
    queryKey: KEYS.commerceDiscoveryCompanionConnections(
      org.id,
      connectionsKey,
    ),
    queryFn: async () => {
      // Suspense queries can't be `enabled`-gated; skip the call when there are
      // no binding requirements (schema resolved above, so this is stable).
      if (requirements.length === 0) {
        return { items: [] as CandidateConnection[] };
      }
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
  const oauthStatusQueries = useSuspenseQueries({
    queries: oauthStatusConnections.map((connection) => ({
      queryKey: KEYS.commerceDiscoveryCompanionOAuthStatus(
        org.id,
        connection.id,
      ),
      queryFn: async () => {
        // Optional metadata: a transient failure must not escalate to the
        // Suspense boundary and blank the whole section. Treat any error
        // (network, non-ok, parse) as "no token".
        try {
          const response = await fetch(
            `/api/${encodeURIComponent(org.slug)}/connections/${encodeURIComponent(connection.id)}/oauth-token/status`,
            { credentials: "include" },
          );
          if (!response.ok) return { hasToken: false };
          const data = (await response.json()) as { hasToken?: unknown };
          return { hasToken: data.hasToken === true };
        } catch {
          return { hasToken: false };
        }
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
  const registryQuery = useSuspenseQuery({
    queryKey: KEYS.commerceDiscoveryCompanionRegistry(org.id, registryKey),
    queryFn: async () => {
      // Suspense queries can't be `enabled`-gated; skip the call when there are
      // no binding requirements (schema resolved above, so this is stable).
      if (requirements.length === 0) {
        return { items: [] as RegistryItemLike[] };
      }
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

  // Shared-SA connection status from commerce-discovery — the source of truth
  // for the SA lane (OAuth is judged locally, above). Non-suspense + soft: while
  // it loads, or when there's no siteUrl yet, SA-bound cards simply read as not
  // connected until it resolves. A binding write invalidates this key.
  const statusQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryConnectionStatus(org.id, siteUrl ?? ""),
    enabled: !!siteUrl,
    queryFn: async () => {
      const result = await selfClient.callTool({
        name: "COMMERCE_DISCOVERY_CONNECTION_STATUS",
        arguments: { siteUrl },
      });
      return unwrapToolResult<ConnectionStatusResult>(result);
    },
  });
  const saBindings: SaBindings = {};
  for (const [bindingType, code] of Object.entries(PROVIDER_BY_BINDING_TYPE)) {
    const p = statusQuery.data?.providers?.[code];
    if (p?.connected && p.via === "sa") {
      saBindings[bindingType] = { resource: p.resource ?? null };
    }
  }
  // The status couldn't actually be read (query failed, or the site isn't
  // claimed for this org): an existing SA binding would render as disconnected.
  // Callers must surface a warning and not hard-gate on SA cards.
  const saStatusUnavailable =
    !!siteUrl && (statusQuery.isError || statusQuery.data?.claimed === false);

  const cards = buildCompanionCards({
    requirements,
    itemsById,
    itemsByName,
    connections,
    connectionReadiness,
    configurationState,
    curated: COMMERCE_COMPANION_MCPS,
    saBindings,
  });

  return { cards, saStatusUnavailable };
}

/** The commerce-discovery connection's stored site URL (metadata.siteUrl).
 *  Shared by the connect-sources tab and the report's per-source deep-link
 *  dialog so both read it through the same query key. Suspends. */
export function useCommerceDiscoverySiteUrl({
  selfClient,
  org,
  cdConnectionId,
}: {
  selfClient: Client;
  org: CompanionOrg;
  cdConnectionId: string;
}): string | undefined {
  const query = useSuspenseQuery({
    queryKey: KEYS.commerceDiscoveryConnection(org.id, cdConnectionId),
    queryFn: async () => {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: cdConnectionId },
      });
      return unwrapToolResult<{
        item: { metadata?: Record<string, unknown> | null } | null;
      }>(result);
    },
    retry: false,
  });
  const siteUrl = query.data.item?.metadata?.siteUrl;
  return typeof siteUrl === "string" ? siteUrl : undefined;
}
