import type { BoundObjectStorage } from "../../object-storage/bound-object-storage";
import { isTextContentType } from "../../object-storage/key-utils";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface RemoteObjectStorageSource {
  kind: "http";
  baseUrl: string;
  headers: Record<string, string>;
  expiresAt: number;
}

interface CreateRemoteObjectStorageOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: FetchFn;
}

function keyUrl(baseUrl: string, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl.replace(/\/$/, "")}/${encodedKey}`;
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `object storage API failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) message = text;
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function withHeaders(
  sourceHeaders: Record<string, string> | undefined,
  extra?: Record<string, string>,
): Headers {
  const headers = new Headers(sourceHeaders);
  for (const [key, value] of Object.entries(extra ?? {})) {
    headers.set(key, value);
  }
  return headers;
}

export function createRemoteObjectStorage(
  options: CreateRemoteObjectStorageOptions,
): BoundObjectStorage {
  const fetchFn = options.fetch ?? fetch;

  const presign = async (
    kind: "presigned-get" | "presigned-put",
    key: string,
    body: { expiresIn?: number; contentType?: string },
  ): Promise<{ url: string; expiresIn: number }> => {
    const res = await fetchFn(keyUrl(`${options.baseUrl}/${kind}`, key), {
      method: "POST",
      headers: withHeaders(options.headers, {
        "content-type": "application/json",
      }),
      body: JSON.stringify(body),
    });
    return parseJsonResponse(res);
  };

  const storage: BoundObjectStorage = {
    getBytesOrPresign: async (key, opts) => {
      const head = await storage.head(key);
      if (head.size > opts.presignWhenLargerThan) {
        return {
          error: "FILE_TOO_LARGE",
          size: head.size,
          maxInlineSize: opts.presignWhenLargerThan,
          presignedUrl: await storage.presignedGetUrl(
            key,
            opts.presignExpiresIn,
          ),
          contentType: head.contentType,
        };
      }
      const bytes = await storage.getBytes(key);
      return {
        content: isTextContentType(head.contentType)
          ? new TextDecoder().decode(bytes)
          : Buffer.from(bytes).toString("base64"),
        contentType: head.contentType,
        encoding: isTextContentType(head.contentType) ? "utf-8" : "base64",
        size: head.size,
        lastModified: head.lastModified,
        etag: head.etag,
      };
    },
    getBytes: async (key) => {
      const res = await fetchFn(keyUrl(options.baseUrl, key), {
        method: "GET",
        headers: withHeaders(options.headers),
      });
      if (!res.ok) {
        throw new Error(`object storage API failed (${res.status})`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    put: async (key, body, putOptions) => {
      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : body;
      const bodyBuffer =
        bytes.buffer instanceof ArrayBuffer
          ? bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            )
          : Uint8Array.from(bytes).buffer;
      const res = await fetchFn(keyUrl(options.baseUrl, key), {
        method: "PUT",
        headers: withHeaders(options.headers, {
          ...(putOptions?.contentType
            ? { "content-type": putOptions.contentType }
            : {}),
        }),
        body: bodyBuffer,
      });
      return parseJsonResponse(res);
    },
    list: async () => {
      throw new Error("Remote object storage list is not supported");
    },
    delete: async () => {
      throw new Error("Remote object storage delete is not supported");
    },
    head: async (key) => {
      const res = await fetchFn(keyUrl(options.baseUrl, key), {
        method: "HEAD",
        headers: withHeaders(options.headers),
      });
      if (!res.ok) {
        throw new Error(`object storage API failed (${res.status})`);
      }
      return {
        contentType:
          res.headers.get("content-type") ?? "application/octet-stream",
        size: Number(res.headers.get("content-length") ?? "0"),
        lastModified: res.headers.get("last-modified")
          ? new Date(res.headers.get("last-modified")!)
          : undefined,
        etag: res.headers.get("etag") ?? undefined,
      };
    },
    presignedGetUrl: async (key, expiresIn) =>
      (await presign("presigned-get", key, { expiresIn })).url,
    presignedPutUrl: async (key, expiresIn, contentType) =>
      (await presign("presigned-put", key, { expiresIn, contentType })).url,
  };
  return storage;
}
