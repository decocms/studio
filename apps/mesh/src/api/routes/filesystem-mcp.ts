/**
 * Filesystem MCP Server
 *
 * An MCP server that implements the FILESYSTEM_BINDING interface
 * using S3-compatible storage as the backing store.
 *
 * Provides inline content access for AI agents (read/write file content
 * directly in tool calls), unlike OBJECT_STORAGE_BINDING which uses presigned URLs.
 *
 * Route: POST /mcp/filesystem
 * Also handles org-scoped connection ID pattern: /mcp/{orgId}_filesystem
 */

import type {
  FsDeleteInput,
  FsDeleteOutput,
  FsListInput,
  FsListOutput,
  FsMetadataInput,
  FsMetadataOutput,
  FsReadInput,
  FsReadOutput,
  FsWriteInput,
  FsWriteOutput,
} from "@decocms/bindings/filesystem";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import type { MeshContext } from "../../core/mesh-context";
import { requireOrganization } from "../../core/mesh-context";
import { S3Service } from "../../filesystem/s3-service";
import {
  FsDeleteInputSchema,
  FsDeleteOutputSchema,
  FsListInputSchema,
  FsListOutputSchema,
  FsMetadataInputSchema,
  FsMetadataOutputSchema,
  FsReadInputSchema,
  FsReadOutputSchema,
  FsWriteInputSchema,
  FsWriteOutputSchema,
} from "../../tools/filesystem/schema";
import { getFilesystemS3Service } from "../../filesystem/factory";

// Local tool definition type
interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

// Define Hono variables type
type Variables = {
  meshContext: MeshContext;
};

const app = new Hono<{ Variables: Variables }>();

function createFilesystemTools(s3: S3Service, orgId: string): ToolDefinition[] {
  return [
    {
      name: "FS_READ",
      description:
        "Read file content. Returns content inline for text files and small binary files (as base64). Returns an error for files exceeding the size limit.",
      inputSchema: FsReadInputSchema,
      outputSchema: FsReadOutputSchema,
      annotations: {
        title: "Read File",
        readOnlyHint: true,
        destructiveHint: false,
      },
      handler: async (args): Promise<FsReadOutput> => {
        const input = args as FsReadInput;
        return s3.readFile(orgId, input.path, input.offset, input.limit);
      },
    },
    {
      name: "FS_WRITE",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
      inputSchema: FsWriteInputSchema,
      outputSchema: FsWriteOutputSchema,
      annotations: {
        title: "Write File",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      handler: async (args): Promise<FsWriteOutput> => {
        const input = args as FsWriteInput;
        return s3.writeFile(
          orgId,
          input.path,
          input.content,
          input.encoding,
          input.contentType,
        );
      },
    },
    {
      name: "FS_LIST",
      description:
        "List files and directories at a given path. Supports pagination and glob pattern filtering on file names.",
      inputSchema: FsListInputSchema,
      outputSchema: FsListOutputSchema,
      annotations: {
        title: "List Files",
        readOnlyHint: true,
        destructiveHint: false,
      },
      handler: async (args): Promise<FsListOutput> => {
        const input = args as FsListInput;
        return s3.listFiles(orgId, input);
      },
    },
    {
      name: "FS_DELETE",
      description: "Delete a single file.",
      inputSchema: FsDeleteInputSchema,
      outputSchema: FsDeleteOutputSchema,
      annotations: {
        title: "Delete File",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      handler: async (args): Promise<FsDeleteOutput> => {
        const input = args as FsDeleteInput;
        return s3.deleteFile(orgId, input.path);
      },
    },
    {
      name: "FS_METADATA",
      description:
        "Get file metadata including size, content type, last modified time, and ETag.",
      inputSchema: FsMetadataInputSchema,
      outputSchema: FsMetadataOutputSchema,
      annotations: {
        title: "File Metadata",
        readOnlyHint: true,
        destructiveHint: false,
      },
      handler: async (args): Promise<FsMetadataOutput> => {
        const input = args as FsMetadataInput;
        return s3.getMetadata(orgId, input.path);
      },
    },
  ];
}

/**
 * Handle a filesystem MCP request with a given context
 */
export async function handleFilesystemMcpRequest(
  req: Request,
  ctx: MeshContext,
): Promise<Response> {
  const org = requireOrganization(ctx);
  const s3 = getFilesystemS3Service();

  if (!s3) {
    return new Response(
      JSON.stringify({
        error: "Filesystem not configured. Set S3_* environment variables.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const tools = createFilesystemTools(s3, org.id);

  const server = new McpServer(
    { name: "filesystem-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  for (const tool of tools) {
    const inputShape =
      "shape" in tool.inputSchema
        ? (tool.inputSchema.shape as z.ZodRawShape)
        : z.object({}).shape;
    const outputShape =
      tool.outputSchema && "shape" in tool.outputSchema
        ? (tool.outputSchema.shape as z.ZodRawShape)
        : z.object({}).shape;

    server.registerTool(
      tool.name,
      {
        description: tool.description ?? "",
        inputSchema: inputShape,
        outputSchema: outputShape,
        annotations: tool.annotations,
      },
      async (args) => {
        try {
          const result = await tool.handler(args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result as { [x: string]: unknown },
          };
        } catch (error) {
          const err = error as Error;
          return {
            content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      },
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse:
      req.headers.get("Accept")?.includes("application/json") ?? false,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

/**
 * Call a filesystem tool directly
 */
export async function callFilesystemTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: MeshContext,
): Promise<{ content: unknown; isError?: boolean }> {
  const org = requireOrganization(ctx);
  const s3 = getFilesystemS3Service();

  if (!s3) {
    return {
      content: [
        {
          type: "text",
          text: "Filesystem not configured. Set S3_* environment variables.",
        },
      ],
      isError: true,
    };
  }

  const tools = createFilesystemTools(s3, org.id);
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    return {
      content: [{ type: "text", text: `Tool not found: ${toolName}` }],
      isError: true,
    };
  }

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid input: ${parsed.error.message}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(parsed.data as Record<string, unknown>);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Filesystem MCP endpoint
 *
 * Route: POST /mcp/filesystem
 */
app.all("/", async (c) => {
  const ctx = c.get("meshContext");
  return handleFilesystemMcpRequest(c.req.raw, ctx);
});

export default app;
