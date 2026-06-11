import { describe, expect, it } from "bun:test";
import { openObjectStorageSource } from "../sources";

describe("openObjectStorageSource", () => {
  it("returns null when no source is provided", async () => {
    await expect(openObjectStorageSource(undefined)).resolves.toBeNull();
  });

  it("opens HTTP object storage sources with put, get, head, and presigned URLs", async () => {
    const objects = new Map<
      string,
      { body: Uint8Array; contentType: string; etag: string }
    >();
    const requests: Array<{
      path: string;
      method: string;
      auth: string | null;
    }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        requests.push({
          path: url.pathname,
          method: req.method,
          auth: req.headers.get("authorization"),
        });

        const decodeKey = (prefix: string) =>
          decodeURIComponent(url.pathname.slice(prefix.length));

        if (url.pathname.startsWith("/object-storage/presigned-get/")) {
          return Response.json({
            url: `https://files.example.com/get/${decodeKey(
              "/object-storage/presigned-get/",
            )}`,
            expiresIn: 60,
          });
        }

        if (url.pathname.startsWith("/object-storage/presigned-put/")) {
          return Response.json({
            url: `https://files.example.com/put/${decodeKey(
              "/object-storage/presigned-put/",
            )}`,
            expiresIn: 60,
          });
        }

        const key = decodeKey("/object-storage/");
        if (req.method === "PUT") {
          const body = new Uint8Array(await req.arrayBuffer());
          objects.set(key, {
            body,
            contentType:
              req.headers.get("content-type") ?? "application/octet-stream",
            etag: `"${key}-etag"`,
          });
          return Response.json({ key, etag: `"${key}-etag"` });
        }

        const object = objects.get(key);
        if (!object) return new Response("not found", { status: 404 });

        const headers = new Headers({
          "content-type": object.contentType,
          "content-length": String(object.body.byteLength),
          etag: object.etag,
        });
        if (req.method === "HEAD") {
          return new Response(null, { headers });
        }
        const bodyBuffer =
          object.body.buffer instanceof ArrayBuffer
            ? object.body.buffer.slice(
                object.body.byteOffset,
                object.body.byteOffset + object.body.byteLength,
              )
            : Uint8Array.from(object.body).buffer;
        return new Response(bodyBuffer, { headers });
      },
    });

    try {
      const storage = await openObjectStorageSource({
        kind: "http",
        baseUrl: `http://localhost:${server.port}/object-storage`,
        headers: { Authorization: "Bearer source-token" },
        expiresAt: 9999999999000,
      });

      expect(storage).not.toBeNull();
      await storage!.put("pages/home.html", "<h1>Home</h1>", {
        contentType: "text/html; charset=utf-8",
      });

      expect(await storage!.getBytes("pages/home.html")).toEqual(
        new TextEncoder().encode("<h1>Home</h1>"),
      );
      expect(await storage!.head("pages/home.html")).toMatchObject({
        contentType: "text/html; charset=utf-8",
        size: 13,
        etag: '"pages/home.html-etag"',
      });
      expect(
        await storage!.getBytesOrPresign("pages/home.html", {
          presignWhenLargerThan: 1,
          presignExpiresIn: 60,
        }),
      ).toMatchObject({
        error: "FILE_TOO_LARGE",
        presignedUrl: "https://files.example.com/get/pages/home.html",
      });
      await expect(
        storage!.presignedPutUrl("pages/home.html", 60, "text/html"),
      ).resolves.toBe("https://files.example.com/put/pages/home.html");

      expect(
        requests.every((request) => request.auth === "Bearer source-token"),
      ).toBeTrue();
    } finally {
      server.stop();
    }
  });
});
