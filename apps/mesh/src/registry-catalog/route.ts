/**
 * Public REST routes for the registry catalog (the MCP store).
 *
 * Global (not org-scoped): the catalog is the same for every org. Mounted
 * top-level in `app.ts`. Read-only; no auth.
 *
 *   GET /api/registry/items?search=&tags=&categories=&name=&limit=&cursor=
 *   GET /api/registry/items/:id
 */

import type { Context } from "hono";
import { getCatalog } from "./catalog";

/** Parse a repeatable/comma-separated query param into a string[]. */
function listParam(c: Context, key: string): string[] | undefined {
  const repeated = c.req.queries(key);
  const values = (repeated ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

export async function listCatalogItemsHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const result = await getCatalog().listItems({
    search: c.req.query("search") || undefined,
    name: c.req.query("name") || undefined,
    tags: listParam(c, "tags"),
    categories: listParam(c, "categories"),
    limit: Number.isFinite(limit) ? limit : undefined,
    cursor: c.req.query("cursor") || undefined,
  });

  return c.json(result);
}

export async function getCatalogItemHandler(c: Context): Promise<Response> {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "Registry item not found" }, 404);
  }
  const item = await getCatalog().getItem(decodeURIComponent(id));
  if (!item) {
    return c.json({ error: "Registry item not found" }, 404);
  }
  return c.json({ item });
}
