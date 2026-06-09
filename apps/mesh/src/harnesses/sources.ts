import type { LanguageModelV3 } from "@ai-sdk/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BoundObjectStorage } from "../object-storage/bound-object-storage";
import { isTextContentType } from "../object-storage/key-utils";

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

export interface DecopilotModelSources {
  primary: DecopilotModelSource;
  image?: DecopilotModelSource;
  deepResearch?: DecopilotModelSource;
  title?: DecopilotModelSource;
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

export interface OpenedObjectStorageSource extends BoundObjectStorage {}

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

export function createHttpObjectStorage(
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
