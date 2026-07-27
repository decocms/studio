/**
 * COLLECTION_CONNECTIONS_LIST Tool
 *
 * List all connections in the organization with collection binding compliance.
 * Supports filtering, sorting, and pagination.
 */

import {
  type Binder,
  createBindingChecker,
  TRIGGER_BINDING,
  BRAND_BINDING,
} from "@decocms/bindings";
import { ASSISTANTS_BINDING } from "@decocms/bindings/assistant";
import {
  CollectionListInputSchema,
  createCollectionListOutputSchema,
} from "@decocms/bindings/collections";
import { LANGUAGE_MODEL_BINDING } from "@decocms/bindings/llm";
import { MCP_BINDING } from "@decocms/bindings/mcp";
import { OBJECT_STORAGE_BINDING } from "@decocms/bindings/object-storage";
import { AI_GATEWAY_BILLING_BINDING } from "@decocms/bindings/ai-gateway";
import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { getBaseUrl } from "../../core/server-constants";
import { requireOrganization } from "../../core/studio-context";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  getMcpListCache,
  fetchWithCache,
  REVALIDATE_MIN_INTERVAL_MS,
} from "../../mcp-clients/mcp-list-cache";
import { listToolsWithTimeout } from "../../mcp-clients";
import { MCP_LIST_TOOLS_TIMEOUT_MS } from "../../core/constants";
import {
  createDevAssetsConnectionEntity,
  usesLocalObjectStorage,
} from "./dev-assets";
import {
  finalizeNonBindingPage,
  shouldConsiderDevAssetsForPage,
} from "./dev-assets-page";
import { type ConnectionEntity, ConnectionEntitySchema } from "./schema";
import { getConnectionSlug } from "@decocms/shared/utils/connection-slug";
import { connectionMatchesWhere } from "./where-match";
import { mapWithConcurrency } from "./map-with-concurrency";

/**
 * Max concurrent live tool probes during binding filtering. Each probe eagerly
 * connects to a downstream MCP server (transport handshake + a `downstream_tokens`
 * read), so an unbounded `Promise.all` over a large org fires dozens at once —
 * saturating the DB pool and blocking the single-threaded event loop while it
 * parses every tool list. Bounding the fan-out keeps a cold cache from spiking
 * CPU and tripping the HPA into a needless replica.
 */
const BINDING_PROBE_CONCURRENCY = 8;

/**
 * Registry binding: matches connections that expose COLLECTION_REGISTRY_APP_LIST
 * or REGISTRY_ITEM_LIST tools (i.e., can act as a store/registry).
 */
const REGISTRY_BINDING: Binder = [
  {
    name: /^(COLLECTION_REGISTRY_APP_LIST|REGISTRY_ITEM_LIST)$/,
    inputSchema: z.object({}),
  },
] as unknown as Binder;

const BUILTIN_BINDING_CHECKERS: Record<string, Binder> = {
  /** @deprecated llm-binding — migrate to native AI SDK providers */
  LLM: LANGUAGE_MODEL_BINDING,
  /** @deprecated llm-binding — migrate to native AI SDK providers */
  LLMS: LANGUAGE_MODEL_BINDING,
  ASSISTANTS: ASSISTANTS_BINDING,
  MCP: MCP_BINDING,
  OBJECT_STORAGE: OBJECT_STORAGE_BINDING,
  AI_GATEWAY_BILLING: AI_GATEWAY_BILLING_BINDING,
  TRIGGER: TRIGGER_BINDING,
  REGISTRY: REGISTRY_BINDING,
  BRAND: BRAND_BINDING,
};

/**
 * Extended input schema with optional binding and include_virtual parameters
 */
const ConnectionListInputSchema = CollectionListInputSchema.extend({
  binding: z
    .union([
      z.array(z.object({}).passthrough()),
      z.object({}).passthrough(),
      z.string(),
    ])
    .optional(),
  include_virtual: z
    .boolean()
    .optional()
    .describe(
      "Whether to include VIRTUAL connections in the results. Defaults to false.",
    ),
  slug: z
    .string()
    .optional()
    .describe(
      "Filter by connection slug. Matches against app_name, or a slug derived from connection_url or title.",
    ),
});

/**
 * Output schema using the ConnectionEntitySchema
 */
const ConnectionListOutputSchema = createCollectionListOutputSchema(
  ConnectionEntitySchema,
);

export const COLLECTION_CONNECTIONS_LIST = defineTool({
  name: "COLLECTION_CONNECTIONS_LIST",
  description:
    "List all connections in the organization with filtering, sorting, and pagination",
  annotations: {
    title: "List Connections",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ConnectionListInputSchema,
  outputSchema: ConnectionListOutputSchema,

  handler: async (input, ctx) => {
    await ctx.access.check();

    const organization = requireOrganization(ctx);

    // Determine which binding to use: well-known binding (string) or provided JSON schema (object)
    const bindingDefinition: Binder | undefined = input.binding
      ? typeof input.binding === "string"
        ? (() => {
            const wellKnownBinding =
              BUILTIN_BINDING_CHECKERS[input.binding.toUpperCase()];
            if (!wellKnownBinding) {
              throw new Error(`Unknown binding: ${input.binding}`);
            }
            return wellKnownBinding;
          })()
        : (input.binding as unknown as Binder)
      : undefined;

    // Create binding checker from the binding definition
    const bindingChecker = bindingDefinition
      ? createBindingChecker(bindingDefinition)
      : undefined;

    // Always push where/orderBy to SQL to reduce the result set.
    // Pagination can only go to SQL when there's no binding filter,
    // since binding filtering happens in-memory and may remove rows.
    const needsBindingFilter = !!bindingChecker;

    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;

    const { items: connections, totalCount: sqlTotalCount } =
      await ctx.storage.connections.list(organization.id, {
        includeVirtual: input.include_virtual ?? false,
        slug: input.slug,
        where: input.where,
        orderBy: input.orderBy,
        // Only push pagination to SQL when no post-filtering is needed
        limit: needsBindingFilter ? undefined : limit,
        offset: needsBindingFilter ? undefined : offset,
      });

    // Only fetch tools from MCP servers when we need them for binding filtering.
    // This avoids expensive live listTools() calls on every page load.
    if (bindingChecker) {
      const cache = getMcpListCache();
      const selfId = WellKnownOrgMCPId.SELF(organization.id);
      await mapWithConcurrency(
        connections,
        BINDING_PROBE_CONCURRENCY,
        async (connection) => {
          if (connection.tools !== null) return;
          // The self MCP requires session auth, so an HTTP round-trip would
          // fail without forwarding cookies. Use in-process transport instead.
          const fetchLive =
            connection.id === selfId
              ? async () => {
                  const { listManagementTools } = await import("../../tools");
                  return listManagementTools(ctx) as Promise<unknown[]>;
                }
              : () =>
                  listToolsWithTimeout(
                    connection,
                    ctx,
                    MCP_LIST_TOOLS_TIMEOUT_MS,
                  );
          const tools = await fetchWithCache(
            "tools",
            connection.id,
            fetchLive,
            cache,
            // Track background revalidations so the request lifecycle awaits
            // (and bounds) them instead of leaking a detached MCP handshake per
            // connection, and throttle them so a polling UI doesn't reconnect to
            // every downstream on every request. Matches connection/get.ts.
            (p) => ctx.pendingRevalidations.push(p),
            REVALIDATE_MIN_INTERVAL_MS,
          );
          if (tools !== null) {
            connection.tools = tools as Tool[];
          }
        },
      );
    }

    // When no external S3 bucket is configured, inject the dev-assets
    // connection so the OBJECT_STORAGE binding is satisfied by the local
    // DevObjectStorage filesystem fallback.
    let devAssetsInjected = false;
    if (
      usesLocalObjectStorage() &&
      shouldConsiderDevAssetsForPage(needsBindingFilter, offset)
    ) {
      const baseUrl = getBaseUrl();
      const devAssetsId = WellKnownOrgMCPId.DEV_ASSETS(organization.id);

      // Only add it when it isn't already present and when it would satisfy the
      // caller's filters. The dev-assets row is injected after the SQL query, so
      // without re-checking the slug and `where` filters here it would bypass
      // them — e.g. leaking into the agent instance selector's `app_name` filter
      // and appearing as a selectable instance for every connection.
      if (!connections.some((c) => c.id === devAssetsId)) {
        const devAssetsConnection = createDevAssetsConnectionEntity(
          organization.id,
          baseUrl,
        );
        const slugMatches =
          !input.slug || getConnectionSlug(devAssetsConnection) === input.slug;
        const whereMatches = connectionMatchesWhere(
          devAssetsConnection,
          input.where,
        );
        if (slugMatches && whereMatches) {
          connections.unshift(devAssetsConnection);
          devAssetsInjected = true;
        }
      }
    }

    // Binding filter: SQL already handled where/orderBy, we just need to
    // post-filter by binding (requires live tool data) and paginate.
    if (needsBindingFilter) {
      const filteredConnections = (
        await Promise.all(
          connections.map(async (connection) => {
            if (!connection.tools || connection.tools.length === 0) {
              return null;
            }

            const isValid = bindingChecker!.isImplementedBy(
              connection.tools.map((t) => ({
                name: t.name,
                inputSchema: t.inputSchema as Record<string, unknown>,
                outputSchema: t.outputSchema as
                  | Record<string, unknown>
                  | undefined,
              })),
            );

            return isValid ? connection : null;
          }),
        )
      ).filter((c): c is ConnectionEntity => c !== null);

      const totalCount = filteredConnections.length;
      const paginatedConnections = filteredConnections.slice(
        offset,
        offset + limit,
      );
      const hasMore = offset + limit < totalCount;

      return {
        items: paginatedConnections,
        totalCount,
        hasMore,
      };
    }

    // Non-binding path: SQL already handled where/orderBy/pagination.
    return finalizeNonBindingPage(
      connections,
      devAssetsInjected,
      limit,
      offset,
      sqlTotalCount,
    );
  },
});
