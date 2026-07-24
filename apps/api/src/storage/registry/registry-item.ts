import {
  type Insertable,
  type Kysely,
  type RawBuilder,
  sql,
  type SqlBool,
  type Updateable,
} from "kysely";
import type {
  PrivateRegistryCreateInput,
  PrivateRegistryDatabase,
  PrivateRegistryItemEntity,
  PrivateRegistryListQuery,
  PrivateRegistryListResult,
  PrivateRegistrySearchItem,
  PrivateRegistrySearchQuery,
  PrivateRegistrySearchResult,
  PrivateRegistryUpdateInput,
  RegistryItemMeta,
  StudioRegistryMeta,
  RegistryWhereExpression,
} from "./types";
import {
  getStudioMcpMetadata,
  withStudioMcpMetadata,
} from "@decocms/shared/registry/metadata";
import {
  csvToList,
  decodeCursor,
  encodeCursor,
  normalizeStringList,
} from "./utils";

type RawRow = {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  server_json: string;
  meta_json: string | null;
  tags: string | null;
  categories: string | null;
  is_public: number;
  is_unlisted: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function getStudioMeta(meta?: RegistryItemMeta): StudioRegistryMeta {
  return (getStudioMcpMetadata(meta) as StudioRegistryMeta | undefined) ?? {};
}

function normalizeStudioMeta(meta: RegistryItemMeta): RegistryItemMeta {
  const studioMeta = getStudioMeta(meta);
  return Object.keys(studioMeta).length
    ? (withStudioMcpMetadata(meta, studioMeta) as RegistryItemMeta)
    : meta;
}

function toCsv(values: string[]): string | null {
  return values.length ? values.join(",") : null;
}

/** Top-level columns on private_registry_item safe for WHERE filtering */
const REGISTRY_TOP_LEVEL_COLUMNS = new Set([
  "id",
  "title",
  "description",
  "is_public",
  "is_unlisted",
  "created_at",
  "updated_at",
  "created_by",
]);

/** Columns stored as integers in DB but exposed as booleans on the entity */
const BOOLEAN_INT_COLUMNS = new Set(["is_public", "is_unlisted"]);

/** Entity field prefixes that map to JSON text columns */
const REGISTRY_JSON_COLUMNS: Record<string, string> = {
  _meta: "meta_json",
  server: "server_json",
};

/**
 * Build a SQL reference for a registry entity field path.
 */
function registryFieldRef(fieldPath: string[]): RawBuilder<unknown> | null {
  if (fieldPath.length === 0) return null;

  const head = fieldPath[0]!;

  if (fieldPath.length === 1 && REGISTRY_TOP_LEVEL_COLUMNS.has(head)) {
    return sql.ref(head);
  }

  // "name" is a virtual field derived from server_json->>'name'
  if (fieldPath.length === 1 && head === "name") {
    return sql`${sql.ref("server_json")}::jsonb->>'name'`;
  }

  const jsonColumn = REGISTRY_JSON_COLUMNS[head];
  if (jsonColumn && fieldPath.length >= 2) {
    const rest = fieldPath.slice(1);
    let expr = sql`${sql.ref(jsonColumn)}::jsonb`;
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i]!;
      expr =
        i === rest.length - 1
          ? sql`${expr}->>${sql.lit(key)}`
          : sql`${expr}->${sql.lit(key)}`;
    }
    return expr;
  }

  return null;
}

/**
 * Convert a value for SQL comparison, handling boolean→integer columns.
 */
function registryValue(column: string, value: unknown): unknown {
  if (!BOOLEAN_INT_COLUMNS.has(column)) return value;
  if (Array.isArray(value)) {
    return value.map((v) => (v === true ? 1 : v === false ? 0 : v));
  }
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

/**
 * Translate a RegistryWhereExpression tree into a Kysely SQL expression.
 */
function applyRegistryWhereToSql(
  where: RegistryWhereExpression,
): RawBuilder<SqlBool> {
  if (Array.isArray(where.conditions) && where.conditions.length) {
    const parts = where.conditions.map((c) => applyRegistryWhereToSql(c));
    switch (where.operator) {
      case "and":
        return sql<SqlBool>`(${sql.join(parts, sql` AND `)})`;
      case "or":
        return sql<SqlBool>`(${sql.join(parts, sql` OR `)})`;
      case "not":
        return sql<SqlBool>`NOT (${sql.join(parts, sql` OR `)})`;
      default:
        return sql<SqlBool>`true`;
    }
  }

  const { field, operator, value } = where;
  if (!field || !operator) return sql<SqlBool>`true`;

  const ref = registryFieldRef(field);
  if (!ref) return sql<SqlBool>`true`;

  const topColumn = field.length === 1 ? field[0]! : "";
  const sqlValue = registryValue(topColumn, value);

  switch (operator) {
    case "eq":
      return sqlValue === null
        ? sql<SqlBool>`${ref} IS NULL`
        : sql<SqlBool>`${ref} = ${sql.val(sqlValue)}`;
    case "gt":
      return sql<SqlBool>`${ref} > ${sql.val(sqlValue)}`;
    case "gte":
      return sql<SqlBool>`${ref} >= ${sql.val(sqlValue)}`;
    case "lt":
      return sql<SqlBool>`${ref} < ${sql.val(sqlValue)}`;
    case "lte":
      return sql<SqlBool>`${ref} <= ${sql.val(sqlValue)}`;
    case "in":
      if (!Array.isArray(sqlValue) || sqlValue.length === 0)
        return sql<SqlBool>`false`;
      return sql<SqlBool>`${ref} IN (${sql.join(sqlValue.map((v: unknown) => sql.val(v)))})`;
    case "like":
      return sql<SqlBool>`${ref} ILIKE ${sql.val(sqlValue)}`;
    case "contains": {
      const escaped = String(sqlValue).replace(/[%_\\]/g, "\\$&");
      return sql<SqlBool>`${ref} ILIKE ${sql.val(`%${escaped}%`)}`;
    }
    default:
      return sql<SqlBool>`true`;
  }
}

/**
 * Build SQL condition checking a CSV text column contains all requested values.
 * Pattern: (',' || column || ',') LIKE '%,value,%' for each value (AND'd).
 */
function csvContainsAll(column: string, values: string[]): RawBuilder<SqlBool> {
  const conditions = values.map((v) => {
    const escaped = v.replace(/[%_\\]/g, "\\$&");
    return sql<SqlBool>`(',' || ${sql.ref(column)} || ',') LIKE ${sql.val(`%,${escaped},%`)}`;
  });
  return sql<SqlBool>`(${sql.join(conditions, sql` AND `)})`;
}

/**
 * ORDER BY expression: official (2) + verified (1) descending.
 */
function officialVerifiedOrderSql(): RawBuilder<unknown> {
  return sql`(
    CASE WHEN COALESCE(
      ${sql.ref("meta_json")}::jsonb->'mcp.studio'->>'official',
      ${sql.ref("meta_json")}::jsonb->'mcp.mesh'->>'official'
    ) = 'true' THEN 2 ELSE 0 END +
    CASE WHEN COALESCE(
      ${sql.ref("meta_json")}::jsonb->'mcp.studio'->>'verified',
      ${sql.ref("meta_json")}::jsonb->'mcp.mesh'->>'verified'
    ) = 'true' THEN 1 ELSE 0 END
  ) desc`;
}

export class RegistryItemStorage {
  constructor(private db: Kysely<PrivateRegistryDatabase>) {}

  async create(
    input: PrivateRegistryCreateInput,
  ): Promise<PrivateRegistryItemEntity> {
    const now = new Date().toISOString();
    const meta = normalizeStudioMeta(input._meta ?? {});
    const studioMeta = getStudioMeta(meta);
    const tags = normalizeStringList(studioMeta.tags);
    const categories = normalizeStringList(studioMeta.categories);

    const row: Insertable<PrivateRegistryDatabase["private_registry_item"]> = {
      id: input.id,
      organization_id: input.organization_id,
      title: input.title,
      description: input.description ?? null,
      server_json: JSON.stringify(input.server),
      meta_json: JSON.stringify(meta),
      tags: toCsv(tags),
      categories: toCsv(categories),
      is_public: input.is_public ? 1 : 0,
      is_unlisted: input.is_unlisted ? 1 : 0,
      created_at: now,
      updated_at: now,
      created_by: input.created_by ?? null,
    };

    await this.db.insertInto("private_registry_item").values(row).execute();
    const created = await this.findById(input.organization_id, input.id);
    if (!created) {
      throw new Error(`Failed to create registry item "${input.id}"`);
    }
    return created;
  }

  async findById(
    organizationId: string,
    id: string,
  ): Promise<PrivateRegistryItemEntity | null> {
    const row = await this.db
      .selectFrom("private_registry_item")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.deserialize(row as RawRow) : null;
  }

  /**
   * Find a registry item by ID first, then fall back to matching the title.
   * This allows callers to pass either an exact ID or a human-readable name.
   */
  async findByIdOrName(
    organizationId: string,
    identifier: string,
  ): Promise<PrivateRegistryItemEntity | null> {
    // Try exact ID match first
    const byId = await this.findById(organizationId, identifier);
    if (byId) return byId;

    // Fall back to title match
    const row = await this.db
      .selectFrom("private_registry_item")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("title", "=", identifier)
      .executeTakeFirst();
    return row ? this.deserialize(row as RawRow) : null;
  }

  async update(
    organizationId: string,
    id: string,
    input: PrivateRegistryUpdateInput,
  ): Promise<PrivateRegistryItemEntity> {
    const current = await this.findById(organizationId, id);
    if (!current) {
      throw new Error(`Registry item not found: ${id}`);
    }

    const mergedMeta = normalizeStudioMeta(input._meta ?? current._meta ?? {});
    const studioMeta = getStudioMeta(mergedMeta);
    const tags = normalizeStringList(studioMeta.tags);
    const categories = normalizeStringList(studioMeta.categories);

    const update: Updateable<PrivateRegistryDatabase["private_registry_item"]> =
      {
        updated_at: new Date().toISOString(),
      };
    if (input.title !== undefined) update.title = input.title;
    if (input.description !== undefined) update.description = input.description;
    if (input.server !== undefined)
      update.server_json = JSON.stringify(input.server);
    if (input._meta !== undefined)
      update.meta_json = JSON.stringify(mergedMeta);
    if (input._meta !== undefined) {
      update.tags = toCsv(tags);
      update.categories = toCsv(categories);
    }
    if (input.is_public !== undefined)
      update.is_public = input.is_public ? 1 : 0;
    if (input.is_unlisted !== undefined)
      update.is_unlisted = input.is_unlisted ? 1 : 0;

    await this.db
      .updateTable("private_registry_item")
      .set(update)
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .execute();

    const updated = await this.findById(organizationId, id);
    if (!updated) {
      throw new Error(`Registry item not found after update: ${id}`);
    }
    return updated;
  }

  async delete(
    organizationId: string,
    id: string,
  ): Promise<PrivateRegistryItemEntity | null> {
    const existing = await this.findById(organizationId, id);
    if (!existing) return null;

    await this.db
      .deleteFrom("private_registry_item")
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .execute();
    return existing;
  }

  async list(
    organizationId: string,
    query: PrivateRegistryListQuery = {},
  ): Promise<PrivateRegistryListResult> {
    let dbQuery = this.db
      .selectFrom("private_registry_item")
      .selectAll()
      .where("organization_id", "=", organizationId);

    if (!query.includeUnlisted) {
      dbQuery = dbQuery.where("is_unlisted", "=", 0);
    }

    const requestedTags = normalizeStringList(query.tags);
    if (requestedTags.length > 0) {
      dbQuery = dbQuery.where(csvContainsAll("tags", requestedTags));
    }

    const requestedCategories = normalizeStringList(query.categories);
    if (requestedCategories.length > 0) {
      dbQuery = dbQuery.where(
        csvContainsAll("categories", requestedCategories),
      );
    }

    if (query.where) {
      dbQuery = dbQuery.where(applyRegistryWhereToSql(query.where));
    }

    // Count before pagination
    const countQuery = this.db
      .selectFrom(dbQuery.as("filtered"))
      .select(sql<number>`count(*)::int`.as("count"));
    const countResult = await countQuery.executeTakeFirst();
    const totalCount = countResult?.count ?? 0;

    // Sort: official first, then verified, then by created_at desc
    dbQuery = dbQuery
      .orderBy(officialVerifiedOrderSql())
      .orderBy("created_at", "desc");

    // Pagination
    const cursorOffset = decodeCursor(query.cursor);
    const offset = cursorOffset ?? query.offset ?? 0;
    const limit = query.limit ?? 24;
    dbQuery = dbQuery.limit(limit).offset(offset);

    const rows = await dbQuery.execute();
    const items = rows.map((row) => this.deserialize(row as RawRow));

    const hasMore = offset + limit < totalCount;
    const nextCursor = hasMore ? encodeCursor(offset + limit) : undefined;

    return {
      items,
      totalCount,
      hasMore,
      nextCursor,
    };
  }

  async listPublic(
    organizationId: string,
    query: PrivateRegistryListQuery = {},
  ): Promise<PrivateRegistryListResult> {
    let dbQuery = this.db
      .selectFrom("private_registry_item")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("is_public", "=", 1)
      .where("is_unlisted", "=", 0);

    const requestedTags = normalizeStringList(query.tags);
    if (requestedTags.length > 0) {
      dbQuery = dbQuery.where(csvContainsAll("tags", requestedTags));
    }

    const requestedCategories = normalizeStringList(query.categories);
    if (requestedCategories.length > 0) {
      dbQuery = dbQuery.where(
        csvContainsAll("categories", requestedCategories),
      );
    }

    if (query.where) {
      dbQuery = dbQuery.where(applyRegistryWhereToSql(query.where));
    }

    // Count before pagination
    const countQuery = this.db
      .selectFrom(dbQuery.as("filtered"))
      .select(sql<number>`count(*)::int`.as("count"));
    const countResult = await countQuery.executeTakeFirst();
    const totalCount = countResult?.count ?? 0;

    // Sort: official first, then verified, then by created_at desc
    dbQuery = dbQuery
      .orderBy(officialVerifiedOrderSql())
      .orderBy("created_at", "desc");

    // Pagination
    const cursorOffset = decodeCursor(query.cursor);
    const offset = cursorOffset ?? query.offset ?? 0;
    const limit = query.limit ?? 24;
    dbQuery = dbQuery.limit(limit).offset(offset);

    const rows = await dbQuery.execute();
    const items = rows.map((row) => this.deserialize(row as RawRow));

    const hasMore = offset + limit < totalCount;
    const nextCursor = hasMore ? encodeCursor(offset + limit) : undefined;

    return {
      items,
      totalCount,
      hasMore,
      nextCursor,
    };
  }

  async getFilters(
    organizationId: string,
    options?: { publicOnly?: boolean; includeUnlisted?: boolean },
  ): Promise<{
    tags: Array<{ value: string; count: number }>;
    categories: Array<{ value: string; count: number }>;
  }> {
    let query = this.db
      .selectFrom("private_registry_item")
      .select(["tags", "categories"])
      .where("organization_id", "=", organizationId);

    if (options?.publicOnly) {
      query = query.where("is_public", "=", 1);
    }
    if (!options?.includeUnlisted) {
      query = query.where("is_unlisted", "=", 0);
    }

    const rows = await query.execute();

    const tagsCount = new Map<string, number>();
    const categoriesCount = new Map<string, number>();

    for (const row of rows) {
      for (const tag of csvToList(row.tags)) {
        tagsCount.set(tag, (tagsCount.get(tag) ?? 0) + 1);
      }
      for (const category of csvToList(row.categories)) {
        categoriesCount.set(category, (categoriesCount.get(category) ?? 0) + 1);
      }
    }

    const toSortedList = (source: Map<string, number>) =>
      Array.from(source.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value.localeCompare(b.value));

    return {
      tags: toSortedList(tagsCount),
      categories: toSortedList(categoriesCount),
    };
  }

  /**
   * Lightweight search returning minimal fields to save tokens.
   * Searches across id, title, description, and server name.
   */
  async search(
    organizationId: string,
    query: PrivateRegistrySearchQuery = {},
    options?: { publicOnly?: boolean; includeUnlisted?: boolean },
  ): Promise<PrivateRegistrySearchResult> {
    let dbQuery = this.db
      .selectFrom("private_registry_item")
      .select([
        "id",
        "title",
        "description",
        "meta_json",
        "server_json",
        "tags",
        "categories",
        "is_public",
        "is_unlisted",
      ])
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc");

    if (options?.publicOnly) {
      dbQuery = dbQuery.where("is_public", "=", 1);
    }
    if (!options?.includeUnlisted) {
      dbQuery = dbQuery.where("is_unlisted", "=", 0);
    }

    const rows = await dbQuery.execute();

    // Text search
    const searchText = query.query?.trim().toLowerCase();
    const requestedTags = normalizeStringList(query.tags);
    const requestedCategories = normalizeStringList(query.categories);

    const filtered = rows.filter((row) => {
      // Free-text search across id, title, description, server name
      if (searchText) {
        const server = safeJsonParse<{ name?: string; description?: string }>(
          row.server_json,
          {},
        );
        const meta = safeJsonParse<RegistryItemMeta>(row.meta_json, {});
        const shortDesc = getStudioMeta(meta).short_description ?? "";
        const haystack = [
          row.id,
          row.title,
          (row as { description?: string | null }).description ?? "",
          server.name ?? "",
          server.description ?? "",
          shortDesc,
        ]
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(searchText)) return false;
      }

      // Tag filter (AND)
      if (requestedTags.length > 0) {
        const itemTags = normalizeStringList(csvToList(row.tags));
        if (!requestedTags.every((tag) => itemTags.includes(tag))) return false;
      }

      // Category filter (AND)
      if (requestedCategories.length > 0) {
        const itemCategories = normalizeStringList(csvToList(row.categories));
        if (!requestedCategories.every((cat) => itemCategories.includes(cat)))
          return false;
      }

      return true;
    });

    // Pagination
    const cursorOffset = decodeCursor(query.cursor);
    const offset = cursorOffset ?? 0;
    const limit = query.limit ?? 20;
    const page = filtered.slice(offset, offset + limit);
    const hasMore = offset + limit < filtered.length;
    const nextCursor = hasMore ? encodeCursor(offset + limit) : undefined;

    // Project to slim shape
    const items: PrivateRegistrySearchItem[] = page.map((row) => ({
      id: row.id,
      title: row.title,
      tags: csvToList(row.tags),
      categories: csvToList(row.categories),
      is_public: row.is_public === 1,
      is_unlisted: (row as { is_unlisted?: number }).is_unlisted === 1,
    }));

    return { items, totalCount: filtered.length, hasMore, nextCursor };
  }

  private deserialize(row: RawRow): PrivateRegistryItemEntity {
    const server = safeJsonParse<Record<string, unknown>>(row.server_json, {});
    const meta = safeJsonParse<RegistryItemMeta>(row.meta_json, {});
    return {
      id: row.id,
      name: typeof server.name === "string" ? server.name : undefined,
      title: row.title,
      description: row.description,
      _meta: meta,
      server: server as PrivateRegistryItemEntity["server"],
      is_public: row.is_public === 1,
      is_unlisted: row.is_unlisted === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...(row.created_by ? { created_by: row.created_by } : {}),
    };
  }
}
