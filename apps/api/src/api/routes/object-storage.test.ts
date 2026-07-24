import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import type { BoundObjectStorage } from "@/object-storage/bound-object-storage";
import { createObjectStorageRoutes } from "./object-storage";

function createApp(objectStorage: BoundObjectStorage | null) {
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();
  app.use("*", async (c, next) => {
    c.set("studioContext", {
      auth: { user: { id: "user-1" } },
      organization: { id: "org-1", slug: "acme" },
      objectStorage,
    } as unknown as StudioContext);
    await next();
  });
  app.route("/", createObjectStorageRoutes());
  return app;
}

describe("createObjectStorageRoutes", () => {
  it("throws when object storage is not configured", async () => {
    const app = createApp(null);

    const res = await app.request("/object-storage/pages/home.html", {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: "<h1>Home</h1>",
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Object storage not configured",
    });
  });

  it("writes, reads, heads, and presigns through the bound object storage", async () => {
    const writes: Array<{
      key: string;
      body: string;
      contentType?: string;
    }> = [];
    const storage = {
      put: async (
        key: string,
        body: Uint8Array,
        options?: { contentType?: string },
      ) => {
        writes.push({
          key,
          body: new TextDecoder().decode(body),
          contentType: options?.contentType,
        });
        return { key, etag: "etag-1" };
      },
      getBytes: async (key: string) => new TextEncoder().encode(`bytes:${key}`),
      head: async (key: string) => ({
        contentType: key.endsWith(".html") ? "text/html" : "text/plain",
        size: 123,
        etag: "etag-1",
        lastModified: new Date("2026-01-01T00:00:00Z"),
      }),
      presignedGetUrl: async (key: string, expiresIn?: number) =>
        `https://storage.example.com/get/${key}?ttl=${expiresIn}`,
      presignedPutUrl: async (
        key: string,
        expiresIn?: number,
        contentType?: string,
      ) =>
        `https://storage.example.com/put/${key}?ttl=${expiresIn}&ct=${contentType}`,
    } as BoundObjectStorage;
    const app = createApp(storage);

    const put = await app.request("/object-storage/pages/home.html", {
      method: "PUT",
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<h1>Home</h1>",
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      key: "pages/home.html",
      etag: "etag-1",
    });
    expect(writes).toEqual([
      {
        key: "pages/home.html",
        body: "<h1>Home</h1>",
        contentType: "text/html; charset=utf-8",
      },
    ]);

    const get = await app.request("/object-storage/pages/home.html");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/html");
    expect(await get.text()).toBe("bytes:pages/home.html");

    const head = await app.request("/object-storage/pages/home.html", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("123");
    expect(head.headers.get("etag")).toBe("etag-1");

    const presignedGet = await app.request(
      "/object-storage/presigned-get/pages/home.html",
      { method: "POST", body: JSON.stringify({ expiresIn: 60 }) },
    );
    expect(await presignedGet.json()).toEqual({
      url: "https://storage.example.com/get/pages/home.html?ttl=60",
      expiresIn: 60,
    });

    const presignedPut = await app.request(
      "/object-storage/presigned-put/pages/home.html",
      {
        method: "POST",
        body: JSON.stringify({
          expiresIn: 120,
          contentType: "text/html; charset=utf-8",
        }),
      },
    );
    expect(await presignedPut.json()).toEqual({
      url: "https://storage.example.com/put/pages/home.html?ttl=120&ct=text/html; charset=utf-8",
      expiresIn: 120,
    });
  });
});
