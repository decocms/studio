import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { StudioContext } from "@/core/studio-context";
import { detectContentType, sanitizeKey } from "@/object-storage/key-utils";

type Variables = { studioContext: StudioContext };

const DEFAULT_EXPIRES_IN = 3600;

function requireStorage(ctx: StudioContext) {
  if (!ctx.auth?.user?.id && !ctx.auth?.apiKey?.id) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  if (!ctx.organization?.id) {
    throw new HTTPException(400, { message: "Organization required" });
  }
  if (!ctx.objectStorage) {
    throw new HTTPException(503, {
      message: "Object storage not configured",
    });
  }
  return ctx.objectStorage;
}

function keyFromPath(path: string, marker: string): string {
  const index = path.indexOf(marker);
  const rawKey = index >= 0 ? path.slice(index + marker.length) : "";
  const key = sanitizeKey(rawKey);
  if (!key) {
    throw new HTTPException(400, { message: "Missing object key" });
  }
  return key;
}

function parsePresignBody(body: unknown): {
  expiresIn: number;
  contentType?: string;
} {
  if (body === null || typeof body !== "object") {
    return { expiresIn: DEFAULT_EXPIRES_IN };
  }
  const value = body as { expiresIn?: unknown; contentType?: unknown };
  const expiresIn =
    typeof value.expiresIn === "number" && Number.isFinite(value.expiresIn)
      ? value.expiresIn
      : DEFAULT_EXPIRES_IN;
  return {
    expiresIn,
    ...(typeof value.contentType === "string"
      ? { contentType: value.contentType }
      : {}),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : Uint8Array.from(bytes).buffer;
}

export const createObjectStorageRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  });

  app.post("/object-storage/presigned-get/*", async (c) => {
    const storage = requireStorage(c.get("studioContext"));
    const key = keyFromPath(c.req.path, "/object-storage/presigned-get/");
    const body = parsePresignBody(await c.req.json().catch(() => ({})));
    const url = await storage.presignedGetUrl(key, body.expiresIn);
    return c.json({ url, expiresIn: body.expiresIn });
  });

  app.post("/object-storage/presigned-put/*", async (c) => {
    const storage = requireStorage(c.get("studioContext"));
    const key = keyFromPath(c.req.path, "/object-storage/presigned-put/");
    const body = parsePresignBody(await c.req.json().catch(() => ({})));
    const url = await storage.presignedPutUrl(
      key,
      body.expiresIn,
      body.contentType,
    );
    return c.json({ url, expiresIn: body.expiresIn });
  });

  app.put("/object-storage/*", async (c) => {
    const storage = requireStorage(c.get("studioContext"));
    const key = keyFromPath(c.req.path, "/object-storage/");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = await storage.put(key, bytes, {
      contentType: c.req.header("content-type") ?? detectContentType(key),
    });
    return c.json(result);
  });

  app.get("/object-storage/*", async (c) => {
    const storage = requireStorage(c.get("studioContext"));
    const key = keyFromPath(c.req.path, "/object-storage/");
    const [head, bytes] = await Promise.all([
      storage.head(key),
      storage.getBytes(key),
    ]);
    return c.body(toArrayBuffer(bytes), 200, {
      "Content-Type": head.contentType,
      "Content-Length": String(head.size),
      ...(head.etag ? { ETag: head.etag } : {}),
      ...(head.lastModified
        ? { "Last-Modified": head.lastModified.toUTCString() }
        : {}),
    });
  });

  app.on("HEAD", "/object-storage/*", async (c) => {
    const storage = requireStorage(c.get("studioContext"));
    const key = keyFromPath(c.req.path, "/object-storage/");
    const head = await storage.head(key);
    return c.body(null, 200, {
      "Content-Type": head.contentType,
      "Content-Length": String(head.size),
      ...(head.etag ? { ETag: head.etag } : {}),
      ...(head.lastModified
        ? { "Last-Modified": head.lastModified.toUTCString() }
        : {}),
    });
  });

  return app;
};
