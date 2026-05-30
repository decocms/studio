/**
 * COLLECTION_CONNECTIONS_LIST Tool
 *
 * List all connections in the organization with collection binding compliance.
 * Supports filtering, sorting, and pagination.
 */

import {
  type Binder,
  createBindingChecker,
  EVENT_BUS_BINDING,
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
import {
  WORKFLOW_BINDING,
  WORKFLOW_EXECUTION_BINDING,
} from "@decocms/bindings/workflow";
import { AI_GATEWAY_BILLING_BINDING } from "@decocms/bindings/ai-gateway";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { getBaseUrl } from "../../core/server-constants";
import { requireOrganization } from "../../core/mesh-context";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  getMcpListCache,
  fetchWithCache,
} from "../../mcp-clients/mcp-list-cache";
import { clientFromConnection } from "../../mcp-clients";
import {
  createDevAssetsConnectionEntity,
  usesLocalObjectStorage,
} from "./dev-assets";
import { type ConnectionEntity, ConnectionEntitySchema } from "./schema";
import { getConnectionSlug } from "@/shared/utils/connection-slug";

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
  WORKFLOW: WORKFLOW_BINDING,
  WORKFLOW_EXECUTION: WORKFLOW_EXECUTION_BINDING,
  AI_GATEWAY_BILLING: AI_GATEWAY_BILLING_BINDING,
  EVENT_BUS: EVENT_BUS_BINDING,
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
      await Promise.all(
        connections.map(async (connection) => {
          if (connection.tools !== null) return;
          // The self MCP requires session auth, so an HTTP round-trip would
          // fail without forwarding cookies. Use in-process transport instead.
          const fetchLive =
            connection.id === selfId
              ? async () => {
                  const { listManagementTools } = await import("../../tools");
                  return listManagementTools(ctx) as Promise<unknown[]>;
                }
              : async () => {
                  const client = await clientFromConnection(
                    connection,
                    ctx,
                    true,
                  );
                  try {
                    const result = await client.listTools();
                    return result.tools;
                  } finally {
                    await client.close().catch(() => {});
                  }
                };
          const tools = await fetchWithCache(
            "tools",
            connection.id,
            fetchLive,
            cache,
          );
          if (tools !== null) {
            connection.tools = tools as Tool[];
          }
        }),
      );
    }

    // When no external S3 bucket is configured, inject the dev-assets
    // connection so the OBJECT_STORAGE binding is satisfied by the local
    // DevObjectStorage filesystem fallback.
    if (usesLocalObjectStorage()) {
      const baseUrl = getBaseUrl();
      const devAssetsId = WellKnownOrgMCPId.DEV_ASSETS(organization.id);

      // Only add if not already in the list and if it matches the slug filter (if any)
      if (!connections.some((c) => c.id === devAssetsId)) {
        const devAssetsConnection = createDevAssetsConnectionEntity(
          organization.id,
          baseUrl,
        );
        const slugMatches =
          !input.slug || getConnectionSlug(devAssetsConnection) === input.slug;
        if (slugMatches) {
          connections.unshift(devAssetsConnection);
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

    // Non-binding path: SQL already handled where/orderBy/pagination
    const hasMore = offset + limit < sqlTotalCount;

    return {
      items: connections,
      totalCount: sqlTotalCount,
      hasMore,
    };
  },
});
