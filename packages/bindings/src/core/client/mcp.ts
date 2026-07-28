/* oxlint-disable no-explicit-any */
import { z } from "zod";
import type { MCPConnection } from "../connection";
import { createMCPClientProxy } from "./proxy";
export type { ServerClient } from "./mcp-client";
// Default fetcher instance with API_SERVER_URL and API_HEADERS
export const MCPClient = new Proxy(
  {} as {
    forClient: <TDefinition extends readonly ToolBinder[]>(
      client: ServerClient,
    ) => MCPClientFetchStub<TDefinition>;
    forConnection: <TDefinition extends readonly ToolBinder[]>(
      connection: MCPConnection,
    ) => MCPClientFetchStub<TDefinition>;
  },
  {
    get(_, name) {
      if (name === "toJSON") {
        return null;
      }

      if (name === "forConnection") {
        return <TDefinition extends readonly ToolBinder[]>(
          connection: MCPConnection,
        ) =>
          createMCPFetchStub<TDefinition>({
            connection,
          });
      }

      if (name === "forClient") {
        return <TDefinition extends readonly ToolBinder[]>(
          client: ServerClient,
        ) =>
          createMCPFetchStub<TDefinition>({
            client,
          });
      }
      return globalThis[name as keyof typeof globalThis];
    },
  },
);

export interface FetchOptions extends RequestInit {
  path?: string;
  segments?: string[];
}

// Default fetcher instance with API_SERVER_URL and API_HEADERS
import type { ToolBinder } from "../binder";
import { ServerClient } from "./mcp-client";
export type { ToolBinder };

export type MCPClientStub<TDefinition extends readonly ToolBinder[]> = {
  [K in TDefinition[number] as K["name"]]: K extends ToolBinder<
    string,
    infer TInput,
    infer TReturn
  >
    ? (params: TInput, init?: RequestInit) => Promise<TReturn>
    : never;
};

export type MCPClientFetchStub<TDefinition extends readonly ToolBinder[]> = {
  listTools: () => Promise<
    {
      id: string;
      inputSchema: z.ZodType;
      outputSchema: z.ZodType;
      description: string;
      execute: (params: any) => Promise<any>;
    }[]
  >;
} & {
  [K in TDefinition[number] as K["name"]]: K extends ToolBinder<
    string,
    infer TInput,
    infer TReturn
  >
    ? (params: TInput, init?: RequestInit) => Promise<Awaited<TReturn>>
    : never;
};

export interface MCPClientRaw {
  callTool: (tool: string, args: unknown) => Promise<unknown>;
  listTools: () => Promise<
    {
      name: string;
      inputSchema: any;
      outputSchema?: any;
      description: string;
    }[]
  >;
}
export type JSONSchemaToZodConverter = (jsonSchema: any) => z.ZodTypeAny;

export interface CreateStubForClientAPIOptions {
  client: ServerClient;
  debugId?: () => string;
  getErrorByStatusCode?: (
    statusCode: number,
    message?: string,
    traceId?: string,
    errorObject?: unknown,
  ) => Error;
}

export interface CreateStubForConnectionAPIOptions {
  connection: MCPConnection;
  debugId?: () => string;
  createServerClient?: (
    mcpServer: { connection: MCPConnection; name?: string },
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ) => ServerClient;
  getErrorByStatusCode?: (
    statusCode: number,
    message?: string,
    traceId?: string,
    errorObject?: unknown,
  ) => Error;
}
export type CreateStubAPIOptions =
  | CreateStubForClientAPIOptions
  | CreateStubForConnectionAPIOptions;

export function createMCPFetchStub<TDefinition extends readonly ToolBinder[]>(
  options: CreateStubAPIOptions,
): MCPClientFetchStub<TDefinition> {
  return createMCPClientProxy<MCPClientFetchStub<TDefinition>>(options);
}
