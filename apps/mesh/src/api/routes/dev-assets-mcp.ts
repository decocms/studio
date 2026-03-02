/**
 * Dev Assets MCP Server
 *
 * A dev-only MCP server that implements the OBJECT_STORAGE_BINDING interface
 * using the local filesystem at `/data/assets/<org_id>/` as the backing store.
 *
 * This enables testing the object-storage plugin locally without needing
 * an actual S3 bucket.
 *
 * Only available when NODE_ENV !== "production"
 */

import {
  type DeleteObjectInput,
  type DeleteObjectOutput,
  type DeleteObjectsInput,
  type DeleteObjectsOutput,
  type GetObjectMetadataInput,
  type GetObjectMetadataOutput,
  type GetPresignedUrlInput,
  type GetPresignedUrlOutput,
  type ListObjectsInput,
  type ListObjectsOutput,
  type PutPresignedUrlInput,
  type PutPresignedUrlOutput,
} from "@decocms/bindings/object-storage";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { MeshContext } from "../../core/mesh-context";
import { requireOrganization } from "../../core/mesh-context";
import { getContentType } from "./dev-assets";

// Local tool definition type
interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  annotations?: {
    [key: string]: unknown;
  };
  _meta?: Record<string, unknown>;
}

// Base directory for assets.
// Uses MESH_HOME/assets when available (local mode), falls back to ./data/assets
const DEV_ASSETS_BASE_DIR = process.env.MESH_HOME
  ? `${process.env.MESH_HOME}/assets`
  : "./data/assets";

// Default URL expiration time in seconds (1 hour)
const DEFAULT_EXPIRES_IN = 3600;

// Local type for file object (matches OBJECT_STORAGE_BINDING list output)
interface FileObject {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
}

// Define Hono variables type
type Variables = {
  meshContext: MeshContext;
};

const app = new Hono<{ Variables: Variables }>();

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the base directory for an organization's assets
 */
function getOrgAssetsDir(orgId: string): string {
  // Sanitize org ID to prevent directory traversal
  const sanitizedOrgId = orgId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(DEV_ASSETS_BASE_DIR, sanitizedOrgId);
}

/**
 * Sanitize a file key to prevent directory traversal
 */
function sanitizeKey(key: string): string {
  // Remove leading slashes and normalize path
  const normalized = key.replace(/^\/+/, "").replace(/\.\./g, "");
  return normalized;
}

/**
 * Get the full file path for a key within an org's assets
 */
function getFilePath(orgId: string, key: string): string {
  const baseDir = getOrgAssetsDir(orgId);
  const sanitizedKey = sanitizeKey(key);
  return join(baseDir, sanitizedKey);
}

/**
 * Generate a simple HMAC signature for presigned URLs
 */
function generateSignature(
  orgId: string,
  key: string,
  expires: number,
  method: "GET" | "PUT",
): string {
  const secret = process.env.ENCRYPTION_KEY || "dev-secret";
  const data = `${orgId}:${key}:${expires}:${method}`;
  return createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Generate a presigned URL for file access
 */
function generatePresignedUrl(
  baseUrl: string,
  orgId: string,
  key: string,
  expiresIn: number,
  method: "GET" | "PUT",
): string {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const signature = generateSignature(orgId, key, expires, method);

  const url = new URL(`/api/dev-assets/${orgId}/${sanitizeKey(key)}`, baseUrl);
  url.searchParams.set("expires", expires.toString());
  url.searchParams.set("signature", signature);
  url.searchParams.set("method", method);

  return url.toString();
}

/**
 * Generate an ETag for a file (simple hash of path + mtime + size)
 */
function generateEtag(filePath: string, mtime: Date, size: number): string {
  const data = `${filePath}:${mtime.getTime()}:${size}`;
  return `"${createHmac("md5", "etag").update(data).digest("hex")}"`;
}

/**
 * Recursively list all files in a directory
 */
async function listFilesRecursive(
  dir: string,
  baseDir: string,
  prefix: string,
  delimiter: string | undefined,
  results: {
    objects: FileObject[];
    commonPrefixes: Set<string>;
  },
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(baseDir, fullPath);
      const key = relativePath.replace(/\\/g, "/"); // Normalize to forward slashes

      // Skip if key doesn't match prefix
      if (prefix && !key.startsWith(prefix)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (delimiter) {
          // When delimiter is set, add directory as common prefix
          const dirPrefix = key + "/";
          if (!prefix || dirPrefix.startsWith(prefix)) {
            // Only add if it's directly under the prefix
            const afterPrefix = prefix ? key.slice(prefix.length) : key;
            if (!afterPrefix.includes("/")) {
              results.commonPrefixes.add(dirPrefix);
            }
          }
        } else {
          // Recurse into subdirectories when no delimiter
          await listFilesRecursive(
            fullPath,
            baseDir,
            prefix,
            delimiter,
            results,
          );
        }
      } else if (entry.isFile()) {
        // Check if file is "inside" a folder when delimiter is used
        if (delimiter && prefix) {
          const afterPrefix = key.slice(prefix.length);
          if (afterPrefix.includes(delimiter)) {
            // File is in a subfolder, add the folder as common prefix
            const folderEnd = afterPrefix.indexOf(delimiter);
            const folderPath = prefix + afterPrefix.slice(0, folderEnd + 1);
            results.commonPrefixes.add(folderPath);
            continue;
          }
        }

        try {
          const fileStat = await stat(fullPath);
          results.objects.push({
            key,
            size: fileStat.size,
            lastModified: fileStat.mtime.toISOString(),
            etag: generateEtag(fullPath, fileStat.mtime, fileStat.size),
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

function createDevAssetsTools(
  ctx: MeshContext,
  baseUrl: string,
): ToolDefinition[] {
  const org = requireOrganization(ctx);
  const orgId = org.id;

  return [
    {
      name: "LIST_OBJECTS",
      description:
        "List objects in the local assets directory with pagination support",
      inputSchema: z.object({
        prefix: z.string().optional(),
        maxKeys: z.number().optional().default(1000),
        continuationToken: z.string().optional(),
        delimiter: z.string().optional(),
      }),
      outputSchema: z.object({
        objects: z.array(
          z.object({
            key: z.string(),
            size: z.number(),
            lastModified: z.string(),
            etag: z.string(),
          }),
        ),
        nextContinuationToken: z.string().optional(),
        isTruncated: z.boolean(),
        commonPrefixes: z.array(z.string()).optional(),
      }),
      handler: async (
        args: Record<string, unknown>,
      ): Promise<ListObjectsOutput> => {
        const input = args as ListObjectsInput;
        const prefix = input.prefix || "";
        const maxKeys = input.maxKeys ?? 1000;
        const delimiter = input.delimiter;
        const continuationToken = input.continuationToken;

        const baseDir = getOrgAssetsDir(orgId);

        // Ensure directory exists
        await mkdir(baseDir, { recursive: true });

        const results: {
          objects: FileObject[];
          commonPrefixes: Set<string>;
        } = {
          objects: [],
          commonPrefixes: new Set(),
        };

        await listFilesRecursive(baseDir, baseDir, prefix, delimiter, results);

        // Sort objects by key for consistent pagination
        results.objects.sort((a, b) => a.key.localeCompare(b.key));

        // Handle pagination
        let startIndex = 0;
        if (continuationToken) {
          // Continuation token is the last key from previous page
          startIndex = results.objects.findIndex(
            (o) => o.key > continuationToken,
          );
          if (startIndex === -1) startIndex = results.objects.length;
        }

        const paginatedObjects = results.objects.slice(
          startIndex,
          startIndex + maxKeys,
        );
        const isTruncated = startIndex + maxKeys < results.objects.length;
        const nextToken = isTruncated
          ? paginatedObjects[paginatedObjects.length - 1]?.key
          : undefined;

        return {
          objects: paginatedObjects,
          isTruncated,
          nextContinuationToken: nextToken,
          commonPrefixes: Array.from(results.commonPrefixes).sort(),
        };
      },
    },
    {
      name: "GET_OBJECT_METADATA",
      description: "Get metadata for a file in the local assets directory",
      inputSchema: z.object({
        key: z.string(),
      }),
      outputSchema: z.object({
        contentType: z.string().optional(),
        contentLength: z.number(),
        lastModified: z.string(),
        etag: z.string(),
        metadata: z.record(z.string(), z.string()).optional(),
      }),
      handler: async (
        args: Record<string, unknown>,
      ): Promise<GetObjectMetadataOutput> => {
        const input = args as GetObjectMetadataInput;
        const filePath = getFilePath(orgId, input.key);

        const fileStat = await stat(filePath);

        return {
          contentType: getContentType(input.key),
          contentLength: fileStat.size,
          lastModified: fileStat.mtime.toISOString(),
          etag: generateEtag(filePath, fileStat.mtime, fileStat.size),
        };
      },
    },
    {
      name: "GET_PRESIGNED_URL",
      description:
        "Generate a presigned URL for downloading a file from local storage",
      inputSchema: z.object({
        key: z.string(),
        expiresIn: z.number().optional(),
      }),
      outputSchema: z.object({
        url: z.string(),
        expiresIn: z.number(),
      }),
      handler: async (
        args: Record<string, unknown>,
      ): Promise<GetPresignedUrlOutput> => {
        const input = args as GetPresignedUrlInput;
        const expiresIn = input.expiresIn ?? DEFAULT_EXPIRES_IN;

        const url = generatePresignedUrl(
          baseUrl,
          orgId,
          input.key,
          expiresIn,
          "GET",
        );

        return {
          url,
          expiresIn,
        };
      },
    },
    {
      name: "PUT_PRESIGNED_URL",
      description:
        "Generate a presigned URL for uploading a file to local storage",
      inputSchema: z.object({
        key: z.string(),
        expiresIn: z.number().optional(),
        contentType: z.string().optional(),
      }),
      outputSchema: z.object({
        url: z.string(),
        expiresIn: z.number(),
      }),
      handler: async (
        args: Record<string, unknown>,
      ): Promise<PutPresignedUrlOutput> => {
        const input = args as PutPresignedUrlInput;
        const expiresIn = input.expiresIn ?? DEFAULT_EXPIRES_IN;

        const url = generatePresignedUrl(
          baseUrl,
          orgId,
          input.key,
          expiresIn,
          "PUT",
        );

        return {
          url,
          expiresIn,
        };
      },
    },
    {
      name: "DELETE_OBJECT",
      description: "Delete a single file from local storage",
      inputSchema: z.object({
        key: z.string(),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        key: z.string(),
      }),
      handler: async (
        args: Record<string, unknown>,
      ): Promise<DeleteObjectOutput> => {
        const input = args as DeleteObjectInput;
        const filePath = getFilePath(orgId, input.key);

        try {
          await rm(filePath);
          return { success: true, key: input.key };
        } catch {
          return { success: false, key: input.key };
        }
      },
    },
    {
      name: "DELETE_OBJECTS",
      description: "Delete multiple files from local storage",
      inputSchema: z.object({
        keys: z.array(z.string()).max(1000),
      }),
      outputSchema: z.object({
        deleted: z.array(z.string()),
        errors: z.array(
          z.object({
            key: z.string(),
            message: z.string(),
          }),
        ),
      }),
      handler: async (
        args: Record<string, unknown>,
      ): Promise<DeleteObjectsOutput> => {
        const input = args as DeleteObjectsInput;
        const deleted: string[] = [];
        const errors: { key: string; message: string }[] = [];

        await Promise.all(
          input.keys.map(async (key: string) => {
            const filePath = getFilePath(orgId, key);
            try {
              await rm(filePath);
              deleted.push(key);
            } catch (err) {
              errors.push({
                key,
                message: err instanceof Error ? err.message : "Unknown error",
              });
            }
          }),
        );

        return { deleted, errors };
      },
    },
  ];
}

// ============================================================================
// MCP Server Route
// ============================================================================

/**
 * Handle a dev-assets MCP request with a given context
 * Exported for use by the connection ID pattern handler
 */
export async function handleDevAssetsMcpRequest(
  req: Request,
  ctx: MeshContext,
  baseUrl: string,
): Promise<Response> {
  const tools = createDevAssetsTools(ctx, baseUrl);

  // Create MCP server directly
  const server = new McpServer(
    { name: "dev-assets-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Register each tool with the server
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
        _meta: tool._meta,
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

  // Create transport and connect
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse:
      req.headers.get("Accept")?.includes("application/json") ?? false,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

/**
 * Call a dev-assets tool directly
 * Exported for use by the call-tool endpoint pattern handler
 */
export async function callDevAssetsTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: MeshContext,
  baseUrl: string,
): Promise<{ content: unknown; isError?: boolean }> {
  const tools = createDevAssetsTools(ctx, baseUrl);
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    return {
      content: [{ type: "text", text: `Tool not found: ${toolName}` }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(args);
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
 * Dev Assets MCP endpoint
 *
 * Route: POST /mcp/dev-assets
 * Implements OBJECT_STORAGE_BINDING for local filesystem storage
 */
app.all("/", async (c) => {
  const ctx = c.get("meshContext");

  // Get base URL for presigned URLs
  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  return handleDevAssetsMcpRequest(c.req.raw, ctx, baseUrl);
});

export default app;
