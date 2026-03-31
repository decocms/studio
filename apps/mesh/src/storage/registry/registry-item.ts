import type { Insertable, Kysely, Updateable } from "kysely";
import type {
  MeshRegistryMeta,
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
  RegistryWhereExpression,
} from "./types";
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

function getMeshMeta(meta?: RegistryItemMeta): MeshRegistryMeta {
  return meta?.["mcp.mesh"] ?? {};
}

/**
 * Sort items so official items appear first, then verified, then the rest.
 * Within each group the original (created_at desc) order is preserved.
 */
function sortByOfficialAndVerified(
  items: PrivateRegistryItemEntity[],
): PrivateRegistryItemEntity[] {
  return [...items].sort((a, b) => {
    const aM = getMeshMeta(a._meta);
    const bM = getMeshMeta(b._meta);
    const aScore = (aM.official ? 2 : 0) + (aM.verified ? 1 : 0);
    const bScore = (bM.official ? 2 : 0) + (bM.verified ? 1 : 0);
    return bScore - aScore;
  });
}

function toCsv(values: string[]): string | null {
  return values.length ? values.join(",") : null;
}

function getPathValue(
  item: PrivateRegistryItemEntity,
  path?: string[],
): unknown {
  if (!path?.length) return undefined;
  let current: unknown = item;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function compareExpression(
  fieldValue: unknown,
  operator?: string,
  value?: unknown,
) {
  if (!operator) return false;

  if (operator === "eq") {
    return fieldValue === value;
  }

  if (operator === "contains" || operator === "like") {
    const text = String(fieldValue ?? "").toLowerCase();
    const query = String(value ?? "").toLowerCase();
    return text.includes(query);
  }

  if (operator === "in") {
    if (!Array.isArray(value)) return false;
    return value.includes(fieldValue);
  }

  if (operator === "gt") return Number(fieldValue) > Number(value);
  if (operator === "gte") return Number(fieldValue) >= Number(value);
  if (operator === "lt") return Number(fieldValue) < Number(value);
  if (operator === "lte") return Number(fieldValue) <= Number(value);

  return false;
}

function evaluateWhere(
  item: PrivateRegistryItemEntity,
  where?: RegistryWhereExpression,
): boolean {
  if (!where) return true;

  if (Array.isArray(where.conditions) && where.conditions.length) {
    if (where.operator === "and") {
      return where.conditions.every((condition) =>
        evaluateWhere(item, condition),
      );
    }
    if (where.operator === "or") {
      return where.conditions.some((condition) =>
        evaluateWhere(item, condition),
      );
    }
    if (where.operator === "not") {
      return !where.conditions.some((condition) =>
        evaluateWhere(item, condition),
      );
    }
  }

  return compareExpression(
    getPathValue(item, where.field),
    where.operator,
    where.value,
  );
}

export class RegistryItemStorage {
  constructor(private db: Kysely<PrivateRegistryDatabase>) {}

  async create(
    input: PrivateRegistryCreateInput,
  ): Promise<PrivateRegistryItemEntity> {
    const now = new Date().toISOString();
    const meta = input._meta ?? {};
    const meshMeta = getMeshMeta(meta);
    const tags = normalizeStringList(meshMeta.tags);
    const categories = normalizeStringList(meshMeta.categories);

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

    const mergedMeta = input._meta ?? current._meta ?? {};
    const meshMeta = getMeshMeta(mergedMeta);
    const tags = normalizeStringList(meshMeta.tags);
    const categories = normalizeStringList(meshMeta.categories);

    const update: Updateable<PrivateRegistryDatabase["private_registry_item"]> =
      {
        updated_at: new Date().toISOString(),
      };
    if (input.title !== undefined) update.title = input.title;
    if (input.description !== undefined) update.description = input.description;
    if (input.server !== undefined)
      update.server_json = JSON.stringify(input.server);
    if (input._meta !== undefined)
      update.meta_json = JSON.stringify(input._meta);
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
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc");

    if (!query.includeUnlisted) {
      dbQuery = dbQuery.where("is_unlisted", "=", 0);
    }

    const rows = await dbQuery.execute();

    const items = rows.map((row) => this.deserialize(row as RawRow));
    const requestedTags = normalizeStringList(query.tags);
    const requestedCategories = normalizeStringList(query.categories);

    const filtered = items.filter((item) => {
      const meshMeta = getMeshMeta(item._meta);
      const itemTags = normalizeStringList(meshMeta.tags);
      const itemCategories = normalizeStringList(meshMeta.categories);

      const matchesTags =
        requestedTags.length === 0 ||
        requestedTags.every((tag) => itemTags.includes(tag));
      const matchesCategories =
        requestedCategories.length === 0 ||
        requestedCategories.every((category) =>
          itemCategories.includes(category),
        );
      const matchesWhere = evaluateWhere(item, query.where);

      return matchesTags && matchesCategories && matchesWhere;
    });

    const sorted = sortByOfficialAndVerified(filtered);
    const cursorOffset = decodeCursor(query.cursor);
    const offset = cursorOffset ?? query.offset ?? 0;
    const limit = query.limit ?? 24;
    const page = sorted.slice(offset, offset + limit);
    const hasMore = offset + limit < sorted.length;
    const nextCursor = hasMore ? encodeCursor(offset + limit) : undefined;

    return {
      items: page,
      totalCount: sorted.length,
      hasMore,
      nextCursor,
    };
  }

  async listPublic(
    organizationId: string,
    query: PrivateRegistryListQuery = {},
  ): Promise<PrivateRegistryListResult> {
    // Query only public AND non-unlisted items from database
    const rows = await this.db
      .selectFrom("private_registry_item")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("is_public", "=", 1)
      .where("is_unlisted", "=", 0)
      .orderBy("created_at", "desc")
      .execute();

    const items = rows.map((row) => this.deserialize(row as RawRow));

    // Normalize requested tags/categories (same semantics as `list`)
    const requestedTags = normalizeStringList(query.tags);
    const requestedCategories = normalizeStringList(query.categories);

    // Apply in-memory filtering (AND semantics, consistent with `list`)
    const filtered = items.filter((item) => {
      const meshMeta = getMeshMeta(item._meta);
      const itemTags = normalizeStringList(meshMeta.tags);
      const itemCategories = normalizeStringList(meshMeta.categories);

      const matchesTags =
        requestedTags.length === 0 ||
        requestedTags.every((tag) => itemTags.includes(tag));
      const matchesCategories =
        requestedCategories.length === 0 ||
        requestedCategories.every((category) =>
          itemCategories.includes(category),
        );
      const matchesWhere = evaluateWhere(item, query.where);

      return matchesTags && matchesCategories && matchesWhere;
    });

    const sorted = sortByOfficialAndVerified(filtered);
    const cursorOffset = decodeCursor(query.cursor);
    const offset = cursorOffset ?? query.offset ?? 0;
    const limit = query.limit ?? 24;
    const page = sorted.slice(offset, offset + limit);
    const hasMore = offset + limit < sorted.length;
    const nextCursor = hasMore ? encodeCursor(offset + limit) : undefined;

    return {
      items: page,
      totalCount: sorted.length,
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
        const shortDesc = meta?.["mcp.mesh"]?.short_description ?? "";
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
