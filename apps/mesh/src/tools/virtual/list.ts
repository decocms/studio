/**
 * VIRTUAL_MCP_LIST Tool
 *
 * List all virtual MCPs for the organization with collection binding compliance.
 */

import {
  CollectionListInputSchema,
  createCollectionListOutputSchema,
  type OrderByExpression,
  type WhereExpression,
} from "@decocms/bindings/collections";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";
import { type VirtualMCPEntity, VirtualMCPEntitySchema } from "./schema";

/**
 * Convert SQL LIKE pattern to regex pattern by tokenizing.
 * Handles % (any chars) and _ (single char) wildcards.
 */
function convertLikeToRegex(likePattern: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < likePattern.length) {
    const char = likePattern[i] as string;
    if (char === "%") {
      result.push(".*");
    } else if (char === "_") {
      result.push(".");
    } else if (/[.*+?^${}()|[\]\\]/.test(char)) {
      // Escape regex special characters
      result.push("\\" + char);
    } else {
      result.push(char);
    }
    i++;
  }

  return result.join("");
}

function isStringOrValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/**
 * Get a field value from a virtual MCP, handling nested paths.
 */
function getFieldValue(
  virtualMcp: VirtualMCPEntity,
  fieldPath: string,
): unknown {
  const parts = fieldPath.split(".");
  let value: unknown = virtualMcp;
  for (const part of parts) {
    if (value == null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function virtualMcpHasConnectionId(
  virtualMcp: VirtualMCPEntity,
  connectionId: string,
) {
  return virtualMcp.connections.some((c) => c.connection_id === connectionId);
}

/**
 * Evaluate a where expression against a virtual MCP entity.
 *
 * Note: we support a special field `connection_id` that matches virtual MCPs that
 * include a connection with that id (via virtualMcp.connections[*].connection_id).
 */
function evaluateWhereExpression(
  virtualMcp: VirtualMCPEntity,
  where: WhereExpression,
): boolean {
  if ("conditions" in where) {
    const { operator, conditions } = where;
    switch (operator) {
      case "and":
        return conditions.every((c) => evaluateWhereExpression(virtualMcp, c));
      case "or":
        return conditions.some((c) => evaluateWhereExpression(virtualMcp, c));
      case "not":
        return !conditions.every((c) => evaluateWhereExpression(virtualMcp, c));
      default:
        return true;
    }
  }

  const { field, operator, value } = where;
  const fieldPath = field.join(".");

  if (fieldPath === "connection_id") {
    if (operator !== "eq" || typeof value !== "string") return false;
    return virtualMcpHasConnectionId(virtualMcp, value);
  }

  const fieldValue = getFieldValue(virtualMcp, fieldPath);

  switch (operator) {
    case "eq":
      return fieldValue === value;
    case "gt":
      return (
        isStringOrValue(fieldValue) &&
        isStringOrValue(value) &&
        fieldValue > value
      );
    case "gte":
      return (
        isStringOrValue(fieldValue) &&
        isStringOrValue(value) &&
        fieldValue >= value
      );
    case "lt":
      return (
        isStringOrValue(fieldValue) &&
        isStringOrValue(value) &&
        fieldValue < value
      );
    case "lte":
      return (
        isStringOrValue(fieldValue) &&
        isStringOrValue(value) &&
        fieldValue <= value
      );
    case "in":
      return Array.isArray(value) && value.includes(fieldValue);
    case "like":
      if (typeof fieldValue !== "string" || typeof value !== "string") {
        return false;
      }
      // Limit pattern length to prevent ReDoS
      if (value.length > 100) return false;
      const pattern = convertLikeToRegex(value);
      return new RegExp(`^${pattern}$`, "i").test(fieldValue);
    case "contains":
      if (typeof fieldValue !== "string" || typeof value !== "string") {
        return false;
      }
      return fieldValue.toLowerCase().includes(value.toLowerCase());
    default:
      return true;
  }
}

function applyOrderBy(
  items: VirtualMCPEntity[],
  orderBy: OrderByExpression[],
): VirtualMCPEntity[] {
  return [...items].sort((a, b) => {
    for (const order of orderBy) {
      const fieldPath = order.field.join(".");
      const aValue = getFieldValue(a, fieldPath);
      const bValue = getFieldValue(b, fieldPath);

      let comparison = 0;

      // Handle nulls
      if (aValue == null && bValue == null) continue;
      if (aValue == null) {
        comparison = order.nulls === "first" ? -1 : 1;
      } else if (bValue == null) {
        comparison = order.nulls === "first" ? 1 : -1;
      } else if (typeof aValue === "string" && typeof bValue === "string") {
        comparison = aValue.localeCompare(bValue);
      } else if (typeof aValue === "number" && typeof bValue === "number") {
        comparison = aValue - bValue;
      } else {
        comparison = String(aValue).localeCompare(String(bValue));
      }

      if (comparison !== 0) {
        return order.direction === "desc" ? -comparison : comparison;
      }
    }
    return 0;
  });
}

/**
 * Input schema for listing virtual MCPs (collection-binding-compliant)
 */
const ListInputSchema = CollectionListInputSchema;

export type ListVirtualMCPsInput = z.infer<typeof ListInputSchema>;

/**
 * Output schema for virtual MCP list
 */
const ListOutputSchema = createCollectionListOutputSchema(
  VirtualMCPEntitySchema,
);

export const VIRTUAL_MCP_LIST = defineTool({
  name: "VIRTUAL_MCP_LIST",
  description: "List Virtual MCPs with filtering, sorting, and pagination.",
  annotations: {
    title: "List Virtual MCPs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ListInputSchema,
  outputSchema: ListOutputSchema,

  handler: async (input, ctx) => {
    await ctx.access.check();
    const organization = requireOrganization(ctx);

    // Fast-path: if the where clause includes connection_id eq, prefilter using the DB index.
    // We still apply the full `where` expression afterwards (in case other conditions exist).
    const connectionIdEq =
      input.where &&
      !("conditions" in input.where) &&
      input.where.field.join(".") === "connection_id" &&
      input.where.operator === "eq" &&
      typeof input.where.value === "string"
        ? input.where.value
        : undefined;

    const virtualMcps = connectionIdEq
      ? await ctx.storage.virtualMcps.listByConnectionId(
          organization.id,
          connectionIdEq,
        )
      : await ctx.storage.virtualMcps.list(organization.id);

    // Virtual MCPs are already in VirtualMCPEntity format (snake_case)
    let filtered: VirtualMCPEntity[] = virtualMcps;

    // Apply where filter if specified
    if (input.where) {
      filtered = filtered.filter((vm) =>
        evaluateWhereExpression(vm, input.where!),
      );
    }

    // Apply orderBy if specified
    if (input.orderBy && input.orderBy.length > 0) {
      filtered = applyOrderBy(filtered, input.orderBy);
    }

    // Calculate pagination
    const totalCount = filtered.length;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const paginated = filtered.slice(offset, offset + limit);
    const hasMore = offset + limit < totalCount;

    return {
      items: paginated,
      totalCount,
      hasMore,
    };
  },
});
