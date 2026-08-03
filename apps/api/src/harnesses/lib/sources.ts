import type { LanguageModelV3 } from "@ai-sdk/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpClientLike {
  close?: () => Promise<void>;
  connect?: unknown;
  listTools?: unknown;
  callTool?: unknown;
  listPrompts?: unknown;
  readResource?: unknown;
}

export type DecopilotMcpSource =
  | {
      kind: "in-process";
      client: McpClientLike;
      close?: () => Promise<void>;
    }
  | {
      kind: "http";
      url: string;
      headers: Record<string, string>;
      expiresAt: number;
    };

export type DecopilotHttpMcpSource = Extract<
  DecopilotMcpSource,
  { kind: "http" }
>;

export type DecopilotObjectStorageSource = {
  kind: "http";
  baseUrl: string;
  headers: Record<string, string>;
  expiresAt: number;
};

export type DecopilotModelSource =
  | {
      kind: "in-process";
      model: LanguageModelV3;
      modelId: string;
    }
  | {
      kind: "secret";
      providerId: string;
      apiKey: string;
      modelId: string;
      baseUrl?: string;
      extraHeaders?: Record<string, string>;
    };

export type DecopilotSecretModelSource = Extract<
  DecopilotModelSource,
  { kind: "secret" }
>;

/** Slot-keyed resolved model sources. Mirrors `ModelsConfig` (decision D14):
 *  `thinking` is the canonical primary slot; `title`/`primary` are gone. */
export interface DecopilotModelSources {
  thinking: DecopilotModelSource;
  fast?: DecopilotModelSource;
  smart?: DecopilotModelSource;
  image?: DecopilotModelSource;
  webSearch?: DecopilotModelSource;
  deepResearch?: DecopilotModelSource;
}

export type DecopilotSecretModelSources = {
  [K in keyof DecopilotModelSources]: DecopilotModelSources[K] extends
    | DecopilotModelSource
    | undefined
    ? Extract<NonNullable<DecopilotModelSources[K]>, { kind: "secret" }>
    : never;
};

export type DecopilotSandboxSource =
  | { kind: "none" }
  | {
      kind: "in-process";
      call: (path: string, input: unknown) => Promise<unknown>;
    }
  | {
      kind: "http";
      baseUrl: string;
      headers?: Record<string, string>;
    };

export interface OpenedMcpSource {
  client: McpClientLike;
  close: () => Promise<void>;
}

/**
 * Object-storage surface a harness source exposes — the portable subset of the
 * cluster's `BoundObjectStorage` that the HTTP-backed source implements.
 * Declared locally (no `@/object-storage` import) so this file stays portable
 * to the harness lib; a concrete `BoundObjectStorage` is structurally
 * assignable to it.
 */
export interface ObjectStorageGetResult {
  content: string;
  contentType: string;
  encoding: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}
export interface ObjectStorageTooLargeResult {
  error: string;
  size: number;
  maxInlineSize: number;
  presignedUrl: string;
  contentType: string;
}
export interface ObjectStorageHeadResult {
  contentType: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}
export interface OpenedObjectStorageSource {
  getBytesOrPresign(
    key: string,
    opts: { presignWhenLargerThan: number; presignExpiresIn?: number },
  ): Promise<ObjectStorageGetResult | ObjectStorageTooLargeResult>;
  getBytes(key: string): Promise<Uint8Array>;
  put(
    key: string,
    body: string | Uint8Array,
    options?: { contentType?: string },
  ): Promise<unknown>;
  list(options?: {
    prefix?: string;
    maxKeys?: number;
    continuationToken?: string;
    delimiter?: string;
  }): Promise<unknown>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<ObjectStorageHeadResult>;
  presignedGetUrl(
    key: string,
    expiresIn?: number,
    opts?: { requireFetchable?: boolean },
  ): Promise<string>;
  presignedPutUrl(
    key: string,
    expiresIn?: number,
    contentType?: string,
  ): Promise<string>;
}

export interface OpenMcpSourceOptions {
  openHttp?: (source: DecopilotHttpMcpSource) => Promise<OpenedMcpSource>;
  clientInfo?: { name: string; version: string };
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CreateHttpObjectStorageOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: FetchFn;
}

export function createSecretModelSource(input: {
  providerId: string;
  apiKey: string;
  modelId: string;
}): DecopilotSecretModelSource {
  if (input.providerId === "openai-compatible") {
    try {
      const parsed = JSON.parse(input.apiKey) as {
        baseUrl?: string;
        apiKey?: string;
      };
      return {
        kind: "secret",
        providerId: input.providerId,
        apiKey: parsed.apiKey ?? "",
        modelId: input.modelId,
        ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      };
    } catch {
      return {
        kind: "secret",
        providerId: input.providerId,
        apiKey: input.apiKey,
        modelId: input.modelId,
      };
    }
  }

  return {
    kind: "secret",
    providerId: input.providerId,
    apiKey: input.apiKey,
    modelId: input.modelId,
  };
}

export async function openObjectStorageSource(
  source: DecopilotObjectStorageSource | undefined,
): Promise<OpenedObjectStorageSource | null> {
  if (!source) return null;
  return createHttpObjectStorage(source);
}

function createHttpObjectStorage(
  options: CreateHttpObjectStorageOptions,
): OpenedObjectStorageSource {
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

  const storage: OpenedObjectStorageSource = {
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

export async function openMcpSource(
  source: DecopilotMcpSource,
  options: OpenMcpSourceOptions = {},
): Promise<OpenedMcpSource> {
  if (source.kind === "in-process") {
    return {
      client: source.client,
      close: source.close ?? (async () => {}),
    };
  }

  if (options.openHttp) {
    return options.openHttp(source);
  }
  return openHttpMcpSource(source, options.clientInfo);
}

async function openHttpMcpSource(
  source: DecopilotHttpMcpSource,
  clientInfo: { name: string; version: string } = {
    name: "decopilot",
    version: "1",
  },
): Promise<OpenedMcpSource> {
  const transport = new StreamableHTTPClientTransport(new URL(source.url), {
    requestInit: { headers: source.headers },
  });
  const client = new Client(clientInfo, { capabilities: {} });

  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
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

// Inlined from `@/object-storage/key-utils` so this file stays portable to
// the harness lib (kept in sync with the cluster copy; both decide whether a
// stored object is decoded as UTF-8 text vs base64).
const TEXT_CONTENT_TYPES = new Set([
  "application/json",
  "text/html",
  "text/css",
  "application/javascript",
  "text/typescript",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/xml",
  "image/svg+xml",
  "application/yaml",
  "application/toml",
]);

function isTextContentType(contentType: string): boolean {
  // Strip parameters (e.g. "application/json; charset=utf-8" → "application/json")
  const mediaType = contentType.split(";")[0]!.trim();
  if (TEXT_CONTENT_TYPES.has(mediaType)) return true;
  if (mediaType.startsWith("text/")) return true;
  return false;
}
