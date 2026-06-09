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

export interface OpenMcpSourceOptions {
  openHttp?: (source: DecopilotHttpMcpSource) => Promise<OpenedMcpSource>;
  clientInfo?: { name: string; version: string };
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
