/**
 * KV API Routes
 *
 * Org-scoped key-value store accessible via API key auth.
 * Routes: GET/PUT/DELETE /api/kv/:key
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { MeshContext } from "@/core/mesh-context";
import type { KVStorage } from "@/storage/kv";
import { INTERESTS_KEY_PREFIX } from "@/storage/interests";

type Variables = {
  meshContext: MeshContext;
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

export function createKVRoutes(deps: KVRouteDeps) {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/kv/:key", async (c) => {
    const meshContext = c.get("meshContext");
    const orgId = meshContext.organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization required" }, 400);
    }

    const key = c.req.param("key");
    if (isReservedKey(key)) {
      return c.json({ error: "Reserved key" }, 403);
    }
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
      const meshContext = c.get("meshContext");
      const orgId = meshContext.organization?.id;
      if (!orgId) {
        return c.json({ error: "Organization required" }, 400);
      }

      const key = c.req.param("key");
      if (isReservedKey(key)) {
        return c.json({ error: "Reserved key" }, 403);
      }

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
    const meshContext = c.get("meshContext");
    const orgId = meshContext.organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization required" }, 400);
    }

    const key = c.req.param("key");
    if (isReservedKey(key)) {
      return c.json({ error: "Reserved key" }, 403);
    }
    await deps.kvStorage.delete(orgId, key);
    return c.json({ ok: true });
  });

  return app;
}
