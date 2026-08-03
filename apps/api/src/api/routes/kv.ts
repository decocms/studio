/**
 * KV API Routes
 *
 * Org-scoped key-value store accessible via API key auth.
 * Routes: GET/PUT/DELETE /api/:org/kv/:key
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { StudioContext } from "@/core/studio-context";
import type { KVStorage } from "@/storage/kv";
import { INTERESTS_KEY_PREFIX } from "@/storage/interests";

type Variables = {
  studioContext: StudioContext;
};

interface KVRouteDeps {
  kvStorage: KVStorage;
}

const MAX_VALUE_SIZE = 1_048_576; // 1MB

/** Key prefixes that hold internal, per-user data and must never be reachable
 *  through the generic kv REST API (other org members could otherwise read or
 *  tamper with them). */
const RESERVED_KEY_PREFIXES = [INTERESTS_KEY_PREFIX];

const isReservedKey = (key: string) =>
  RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

/** Shared org-id + reserved-key gate for every kv handler below. Returns the
 *  resolved orgId/key, or a Response to short-circuit the request with. */
function resolveKvRequest(
  c: Context<{ Variables: Variables }, "/kv/:key">,
): { orgId: string; key: string } | Response {
  const orgId = c.get("studioContext").organization?.id;
  if (!orgId) {
    return c.json({ error: "Organization required" }, 400);
  }

  const key = c.req.param("key");
  if (isReservedKey(key)) {
    return c.json({ error: "Reserved key" }, 403);
  }

  return { orgId, key };
}

export function createKVRoutes(deps: KVRouteDeps) {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/kv/:key", async (c) => {
    const resolved = resolveKvRequest(c);
    if (resolved instanceof Response) return resolved;
    const { orgId, key } = resolved;

    const value = await deps.kvStorage.get(orgId, key);
    if (value === null) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ key, value });
  });

  app.put(
    "/kv/:key",
    bodyLimit({
      maxSize: MAX_VALUE_SIZE,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
    async (c) => {
      const resolved = resolveKvRequest(c);
      if (resolved instanceof Response) return resolved;
      const { orgId, key } = resolved;

      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      await deps.kvStorage.set(orgId, key, body);
      return c.json({ ok: true });
    },
  );

  app.delete("/kv/:key", async (c) => {
    const resolved = resolveKvRequest(c);
    if (resolved instanceof Response) return resolved;
    const { orgId, key } = resolved;

    await deps.kvStorage.delete(orgId, key);
    return c.json({ ok: true });
  });

  return app;
}
