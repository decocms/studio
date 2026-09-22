import {
  likePatternToRegExp,
  type WhereExpression,
} from "@decocms/bindings/collections";
import { getStudioMcpMetadata } from "@decocms/shared/registry/metadata";
import { z } from "zod";
import { RegistryItemSchema, RegistryListInputSchema } from "./schema";

const REGISTRY_URL =
  "https://raw.githubusercontent.com/decocms/mcps/main/registry.json";
const CACHE_TTL_MS = 5 * 60_000;
const MAX_STALE_MS = 60 * 60_000;
const MAX_BYTES = 10 * 1024 * 1024;
const CatalogSchema = z
  .array(RegistryItemSchema)
  .max(10_000)
  .superRefine((items, ctx) => {
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate registry id: ${item.id}`,
        });
      ids.add(item.id);
    }
  });
type CatalogItem = z.infer<typeof RegistryItemSchema>;

export function parseCatalog(data: unknown): CatalogItem[] {
  return CatalogSchema.parse(data).map((item) => ({
    ...item,
    name: item.name ?? item.server.name,
  }));
}

let cached:
  | {
      items: CatalogItem[];
      fetchedAt: number;
      retryAt: number;
      etag: string | null;
    }
  | undefined;
let pending: Promise<CatalogItem[]> | undefined;

async function refreshCatalog(): Promise<CatalogItem[]> {
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 304 && cached) {
      cached.fetchedAt = Date.now();
      cached.retryAt = Date.now() + CACHE_TTL_MS;
      return cached.items;
    }
    if (!response.ok)
      throw new Error(`Deco registry unavailable (${response.status})`);
    if (!response.body)
      throw new Error("Deco registry returned an empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES)
          throw new Error("Deco registry exceeds size limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const items = parseCatalog(JSON.parse(new TextDecoder().decode(bytes)));
    cached = {
      items,
      fetchedAt: Date.now(),
      retryAt: Date.now() + CACHE_TTL_MS,
      etag: response.headers.get("etag"),
    };
    return items;
  } catch (error) {
    if (cached && Date.now() - cached.fetchedAt < MAX_STALE_MS) {
      cached.retryAt = Date.now() + CACHE_TTL_MS;
      return cached.items;
    }
    throw error;
  }
}

export async function getCatalog(): Promise<CatalogItem[]> {
  if (
    cached &&
    Date.now() < cached.retryAt &&
    Date.now() - cached.fetchedAt < MAX_STALE_MS
  )
    return cached.items;
  pending ??= refreshCatalog().finally(() => {
    pending = undefined;
  });
  return pending;
}

function fieldValue(item: CatalogItem, path: string[]): unknown {
  let value: unknown = item;
  for (const key of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function matches(item: CatalogItem, where: WhereExpression): boolean {
  if ("conditions" in where) {
    if (where.operator === "or")
      return where.conditions.some((condition) => matches(item, condition));
    const every = where.conditions.every((condition) =>
      matches(item, condition),
    );
    return where.operator === "not" ? !every : every;
  }
  const actual = fieldValue(item, where.field);
  const expected = where.value;
  if (actual === undefined) return false;
  switch (where.operator) {
    case "eq":
      return actual === expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "contains":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    case "like":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        likePatternToRegExp(expected).test(actual)
      );
    default: {
      if (
        !(
          (typeof actual === "number" && typeof expected === "number") ||
          (typeof actual === "string" && typeof expected === "string")
        )
      )
        return false;
      if (where.operator === "gt") return actual > expected;
      if (where.operator === "gte") return actual >= expected;
      if (where.operator === "lt") return actual < expected;
      return actual <= expected;
    }
  }
}

export function listCatalog(
  items: CatalogItem[],
  input: z.infer<typeof RegistryListInputSchema>,
) {
  const filtered = items.filter((item) => {
    const meta = getStudioMcpMetadata(item._meta);
    return (
      (!input.where || matches(item, input.where)) &&
      (input.tags ?? []).every((tag) => meta?.tags?.includes(tag)) &&
      (input.categories ?? []).every((category) =>
        meta?.categories?.includes(category),
      )
    );
  });
  filtered.sort((a, b) => {
    for (const order of input.orderBy ?? []) {
      const left = fieldValue(a, order.field);
      const right = fieldValue(b, order.field);
      if (left == null || right == null) {
        if (left == null && right == null) continue;
        const first = order.nulls === "first";
        return left == null ? (first ? -1 : 1) : first ? 1 : -1;
      }
      const comparison =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right));
      if (comparison)
        return order.direction === "desc" ? -comparison : comparison;
    }
    return a.id.localeCompare(b.id);
  });
  const offset =
    input.cursor === undefined ? (input.offset ?? 0) : Number(input.cursor);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (input.cursor !== undefined && !/^\d+$/.test(input.cursor))
  )
    throw new Error("Invalid registry cursor");
  const limit = input.limit ?? 24;
  const page = filtered.slice(offset, offset + limit);
  const hasMore = offset + page.length < filtered.length;
  return {
    items: page,
    totalCount: filtered.length,
    hasMore,
    nextCursor: hasMore ? String(offset + page.length) : undefined,
  };
}

export function resolveItemIdentifier(input: {
  id?: string;
  name?: string;
}): string {
  const itemId = input.id ?? input.name;
  if (!itemId) throw new Error("Either 'id' or 'name' is required");
  return itemId;
}

export function findCatalogItem(items: CatalogItem[], identifier: string) {
  return (
    items.find((item) => item.id === identifier) ??
    items.find(
      (item) => item.name === identifier || item.server.name === identifier,
    ) ??
    null
  );
}

export function catalogFilters(items: CatalogItem[]) {
  const tags = new Map<string, number>();
  const categories = new Map<string, number>();
  for (const item of items) {
    const meta = getStudioMcpMetadata(item._meta);
    for (const tag of new Set(meta?.tags ?? []))
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
    for (const category of new Set(meta?.categories ?? []))
      categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const sorted = (counts: Map<string, number>) =>
    [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value));
  return { tags: sorted(tags), categories: sorted(categories) };
}
