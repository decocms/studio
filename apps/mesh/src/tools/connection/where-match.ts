/**
 * In-memory evaluation of a collection `WhereExpression` against a single
 * ConnectionEntity.
 *
 * The synthetic "Local Files" (dev-assets) connection is injected into
 * COLLECTION_CONNECTIONS_LIST *after* the SQL query runs, so it bypasses the
 * caller's `where` filter. Without this guard the dev-assets row leaks into
 * queries scoped to a different app — e.g. the agent instance selector filters
 * by `app_name = <app>`, yet Local Files appeared as a selectable instance for
 * every connection. This evaluates the same `where` against the injected row so
 * it is only added when it would have matched the query.
 *
 * Semantics intentionally mirror `applyWhereToSql()` in
 * ../../storage/connection.ts:
 *  - `and`/`or`/`not`, and an empty condition list => true
 *  - a comparison on a field the entity does not have => no-op (true)
 *  - `like`/`contains` are case-insensitive (Postgres ILIKE)
 */

import { getConnectionSlug } from "@/shared/utils/connection-slug";
import type { WhereExpression } from "@decocms/bindings/collections";
import type { ConnectionEntity } from "./schema";

function resolveFieldValue(
  connection: ConnectionEntity,
  field: string[],
): unknown {
  if (field.length === 0) return undefined;
  const [head, ...rest] = field;

  // `slug` is a derived column in SQL; compute it the same way here so a slug
  // filter resolves consistently for the synthetic connection.
  let current: unknown =
    head === "slug"
      ? getConnectionSlug(connection)
      : (connection as unknown as Record<string, unknown>)[head!];

  for (const key of rest) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Translate a SQL LIKE/ILIKE pattern (`%`, `_`) into a case-insensitive regex. */
function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const translated = escaped.replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${translated}$`, "i");
}

function matchesComparison(
  fieldValue: unknown,
  operator: string,
  value: unknown,
): boolean {
  // Field absent on the entity: mirror SQL's "unknown field => true" no-op so
  // we never hide the connection based on a filter it cannot be evaluated
  // against (e.g. excluded/sensitive columns).
  if (fieldValue === undefined) return true;

  switch (operator) {
    case "eq":
      return value === null ? fieldValue === null : fieldValue === value;
    case "gt":
      return (fieldValue as number) > (value as number);
    case "gte":
      return (fieldValue as number) >= (value as number);
    case "lt":
      return (fieldValue as number) < (value as number);
    case "lte":
      return (fieldValue as number) <= (value as number);
    case "in":
      return Array.isArray(value) && value.includes(fieldValue);
    case "like":
      return (
        typeof fieldValue === "string" &&
        likeToRegExp(String(value)).test(fieldValue)
      );
    case "contains":
      return String(fieldValue)
        .toLowerCase()
        .includes(String(value).toLowerCase());
    default:
      return true;
  }
}

/**
 * Returns true when `connection` satisfies the `where` expression (or when
 * there is no filter).
 */
export function connectionMatchesWhere(
  connection: ConnectionEntity,
  where: WhereExpression | undefined,
): boolean {
  if (!where) return true;

  if ("conditions" in where) {
    const { operator, conditions } = where;
    if (conditions.length === 0) return true;
    switch (operator) {
      case "and":
        return conditions.every((c) => connectionMatchesWhere(connection, c));
      case "or":
        return conditions.some((c) => connectionMatchesWhere(connection, c));
      case "not":
        // SQL: NOT (c1 AND c2 ...)
        return !conditions.every((c) => connectionMatchesWhere(connection, c));
      default:
        return true;
    }
  }

  const fieldValue = resolveFieldValue(connection, where.field);
  return matchesComparison(fieldValue, where.operator, where.value);
}
