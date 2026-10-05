import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import type { KVStorage } from "@/storage/kv";
import { createKVRoutes } from "./kv";

function createStorage() {
  const values = new Map<string, Record<string, unknown>>();
  const storage = {
    get: async (orgId: string, key: string) =>
      values.get(`${orgId}/${key}`) ?? null,
    set: async (orgId: string, key: string, value: Record<string, unknown>) => {
      values.set(`${orgId}/${key}`, value);
    },
    delete: async (orgId: string, key: string) => {
      values.delete(`${orgId}/${key}`);
    },
  } as unknown as KVStorage;
  return { storage, values };
}

function createApp(auth: StudioContext["auth"] | undefined, kv: KVStorage) {
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();
  app.use("*", async (c, next) => {
    c.set("studioContext", {
      auth,
      organization: { id: "org-1", slug: "acme" },
    } as unknown as StudioContext);
    await next();
  });
  app.route("/", createKVRoutes({ kvStorage: kv }));
  return app;
}

describe("createKVRoutes", () => {
  for (const [label, auth] of [
    ["no auth", undefined],
    ["auth without a principal", { user: undefined }],
  ] as const) {
    it(`rejects every method with 401 for ${label}`, async () => {
      const { storage, values } = createStorage();
      values.set("org-1/triggers:conn", { secret: "s" });
      const app = createApp(auth as StudioContext["auth"] | undefined, storage);

      const get = await app.request("/kv/triggers:conn");
      const put = await app.request("/kv/triggers:conn", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "attacker" }),
      });
      const del = await app.request("/kv/triggers:conn", { method: "DELETE" });

      for (const res of [get, put, del]) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "Unauthorized" });
      }
      expect(values.get("org-1/triggers:conn")).toEqual({ secret: "s" });
    });
  }

  it("serves a signed-in user", async () => {
    const { storage } = createStorage();
    const app = createApp(
      { user: { id: "user-1" } } as StudioContext["auth"],
      storage,
    );

    const put = await app.request("/kv/a", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    expect(put.status).toBe(200);

    const get = await app.request("/kv/a");
    expect(await get.json()).toEqual({ key: "a", value: { n: 1 } });

    const del = await app.request("/kv/a", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request("/kv/a")).status).toBe(404);
  });

  it("serves an API key caller", async () => {
    const { storage } = createStorage();
    const app = createApp(
      {
        user: { id: "user-1" },
        apiKey: { id: "key-1", name: "runtime", userId: "user-1" },
      } as StudioContext["auth"],
      storage,
    );

    expect((await app.request("/kv/missing")).status).toBe(404);
  });

  it("still refuses reserved keys to an authenticated caller", async () => {
    const { storage } = createStorage();
    const app = createApp(
      { user: { id: "user-1" } } as StudioContext["auth"],
      storage,
    );

    expect((await app.request("/kv/interests:user-1")).status).toBe(403);
  });
});
