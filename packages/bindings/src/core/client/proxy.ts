/* oxlint-disable no-explicit-any */
import { convertJsonSchemaToZod } from "zod-from-json-schema";
import type { CreateStubAPIOptions } from "./mcp";
import { createServerClient } from "./mcp-client";

const safeParse = (content: string) => {
  try {
    return JSON.parse(content as string);
  } catch {
    return content;
  }
};

type Tool = {
  name: string;
  inputSchema: any;
  outputSchema?: any;
  description: string;
};

const toolsMap = new Map<string, Promise<Array<Tool>>>();

// Memoize JSON-schema → Zod conversion by schema content. Zod v4 schemas carry
// their methods per-instance, so a freshly-converted schema is ~18 Function/
// AsyncFunction nodes; `mapTool` runs on EVERY `asCallableTools()`/`asTool()`
// call, so without this an MCP server's whole tool set was re-minted into a new
// Zod graph per call and retained by whatever held the result — a dominant
// heap-leak vector server-side (runtime/workflows/sandbox hit this path). The
// conversion is pure and Zod schemas are immutable after build, so sharing one
// instance per distinct schema is safe. Distinct schema contents are bounded by
// the tool catalogue, so no eviction is needed (mirrors sharedJsonSchemaValidator).
const zodSchemaCache = new Map<string, unknown>();
const cachedConvertJsonSchemaToZod = (schema: any) => {
  const key = JSON.stringify(schema);
  const hit = zodSchemaCache.get(key);
  if (hit !== undefined) return hit;
  const zod = convertJsonSchemaToZod(schema);
  zodSchemaCache.set(key, zod);
  return zod;
};

const mapTool = (
  tool: Tool,
  callToolFn: (input: any, toolName?: string) => Promise<any>,
) => {
  return {
    ...tool,
    id: tool.name,
    inputSchema: tool.inputSchema
      ? cachedConvertJsonSchemaToZod(tool.inputSchema)
      : undefined,
    outputSchema: tool.outputSchema
      ? cachedConvertJsonSchemaToZod(tool.outputSchema)
      : undefined,
    execute: (input: any) => {
      return callToolFn(input.context, tool.name);
    },
  };
};
/**
 * The base fetcher used to fetch the MCP from API.
 */
export function createMCPClientProxy<T extends Record<string, unknown>>(
  options: CreateStubAPIOptions,
): T {
  const createClient = (extraHeaders?: Record<string, string>) => {
    if ("connection" in options) {
      return createServerClient(
        { connection: options.connection },
        undefined,
        extraHeaders,
      );
    }
    return options.client;
  };
  return new Proxy<T>({} as T, {
    get(_, name) {
      if (name === "toJSON") {
        return null;
      }
      if (typeof name !== "string") {
        throw new Error("Name must be a string");
      }
      if (name === "listTools") {
        return asCallableTools;
      }
      async function callToolFn(
        args: Record<string, unknown>,
        toolName = name,
      ) {
        const debugId = options?.debugId?.();
        const extraHeaders = debugId
          ? { "x-trace-debug-id": debugId }
          : undefined;

        const { client } = await createClient(extraHeaders);

        const { structuredContent, isError, content } = await client.callTool({
          name: String(toolName),
          arguments: args as Record<string, unknown>,
        });

        if (isError) {
          const maybeErrorMessage = (content as { text: string }[])?.[0]?.text;
          const error =
            typeof maybeErrorMessage === "string"
              ? safeParse(maybeErrorMessage)
              : null;

          const throwableError =
            error?.code && typeof options?.getErrorByStatusCode === "function"
              ? options.getErrorByStatusCode(
                  error.code,
                  error.message,
                  error.traceId,
                )
              : null;

          if (throwableError) {
            throw throwableError;
          }

          throw new Error(
            `Tool ${String(toolName)} returned an error: ${JSON.stringify(
              structuredContent ?? content,
            )}`,
          );
        }

        // Prefer structuredContent, but fall back to parsing content[0].text
        // structuredContent may be undefined if the response doesn't include it
        // (e.g., SDK version mismatch, schema parsing stripping unknown fields)
        if (structuredContent !== undefined) {
          return structuredContent;
        }
        const textContent = (content as { text: string }[])?.[0]?.text;
        return typeof textContent === "string"
          ? safeParse(textContent)
          : undefined;
      }

      async function listToolsFn() {
        const { client } = await createClient();
        const { tools } = await client.listTools();

        return tools as {
          name: string;
          inputSchema: any;
          outputSchema?: any;
          description: string;
        }[];
      }

      async function listToolsOnce() {
        if (!("connection" in options)) {
          return listToolsFn();
        }
        const conn = options.connection;
        const key = JSON.stringify(conn);

        try {
          if (!toolsMap.has(key)) {
            toolsMap.set(key, listToolsFn());
          }

          return await toolsMap.get(key)!;
        } catch (error) {
          console.error("Failed to list tools", error);

          toolsMap.delete(key);
          return;
        }
      }

      async function asCallableTools() {
        const tools = (await listToolsOnce()) ?? [];
        return tools.map((tool) => mapTool(tool, callToolFn));
      }

      callToolFn.asTool = async () => {
        const tools = (await listToolsOnce()) ?? [];
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          throw new Error(`Tool ${name} not found`);
        }

        return mapTool(tool, callToolFn);
      };
      return callToolFn;
    },
  });
}
