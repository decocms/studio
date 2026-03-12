/**
 * MCP Local Dev - Tool Definitions
 *
 * Minimal tool set:
 * - edit_file: Reliable search/replace code edits with diff preview
 * - OBJECT_STORAGE_BINDING tools: Required by the file browser plugin
 *
 * Filesystem reads/writes, git, dev servers, etc. are all handled by the
 * bash tool (registered separately via registerBashTool).
 *
 * NOTE: The HTTP /files/<key> handler must call storage.resolvePath(key)
 * and verify the result starts with storage.root before serving.
 * This prevents path traversal attacks on presigned URLs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LocalFileStorage } from "./storage.ts";
import { logTool } from "./logger.ts";

/**
 * Wrap a tool handler with logging
 */
function withLogging<T extends Record<string, unknown>>(
  toolName: string,
  handler: (args: T) => Promise<CallToolResult>,
): (args: T) => Promise<CallToolResult> {
  return async (args: T) => {
    logTool(toolName, args as Record<string, unknown>);
    const result = await handler(args);
    return result;
  };
}

/**
 * Register edit_file and object storage tools on an MCP server.
 *
 * @param server - The MCP server instance
 * @param storage - The LocalFileStorage instance (scopes all paths to root)
 * @param baseFileUrl - Base URL for presigned file URLs (e.g. "/api/local-dev/files/conn_xxx")
 */
export function registerTools(
  server: McpServer,
  storage: LocalFileStorage,
  baseFileUrl: string,
) {
  // ============================================================
  // EDIT FILE - Reliable search/replace for code changes
  // ============================================================

  server.registerTool(
    "edit_file",
    {
      title: "Edit File",
      description:
        "Make line-based edits to a text file. Each edit replaces exact text sequences " +
        "with new content. Returns a git-style diff showing the changes made. " +
        "Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path to the file to edit"),
        edits: z.array(
          z.object({
            oldText: z
              .string()
              .describe("Text to search for - must match exactly"),
            newText: z.string().describe("Text to replace with"),
          }),
        ),
        dryRun: z
          .boolean()
          .default(false)
          .describe("Preview changes using git-style diff format"),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
      },
    },
    withLogging("edit_file", async (args): Promise<CallToolResult> => {
      try {
        const result = await storage.read(args.path, "utf-8");
        let content = result.content;
        const originalContent = content;

        // Apply all edits
        for (const edit of args.edits) {
          if (!content.includes(edit.oldText)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Could not find text to replace: "${edit.oldText.slice(0, 50)}..."`,
                },
              ],
              isError: true,
            };
          }
          content = content.replace(edit.oldText, edit.newText);
        }

        // Generate diff
        const diff = generateDiff(args.path, originalContent, content);

        if (args.dryRun) {
          return {
            content: [
              {
                type: "text",
                text: `Dry run - changes not applied:\n\n${diff}`,
              },
            ],
            structuredContent: { content: diff, dryRun: true },
          };
        }

        // Apply changes
        await storage.write(args.path, content, {
          encoding: "utf-8",
          createParents: false,
          overwrite: true,
        });

        return {
          content: [{ type: "text", text: diff }],
          structuredContent: { content: diff },
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error: ${(error as Error).message}` },
          ],
          isError: true,
        };
      }
    }),
  );

  // ============================================================
  // OBJECT STORAGE BINDING TOOLS
  // Required by the file browser plugin (mesh-plugin-object-storage)
  // ============================================================

  // LIST_OBJECTS - List files with S3-like interface
  server.registerTool(
    "LIST_OBJECTS",
    {
      title: "List Objects",
      description:
        "List files and folders with S3-compatible interface. " +
        "Use prefix to filter by folder path, delimiter '/' to group by folders.",
      inputSchema: {
        prefix: z
          .string()
          .optional()
          .default("")
          .describe(
            "Filter objects by prefix (e.g., 'folder/' for folder contents)",
          ),
        maxKeys: z
          .number()
          .optional()
          .default(1000)
          .describe("Maximum number of keys to return"),
        continuationToken: z
          .string()
          .optional()
          .describe("Token for pagination (offset as string)"),
        delimiter: z
          .string()
          .optional()
          .describe("Delimiter for grouping keys (typically '/')"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("LIST_OBJECTS", async (args): Promise<CallToolResult> => {
      try {
        const prefix = args.prefix || "";
        const maxKeys = args.maxKeys || 1000;
        const offset = args.continuationToken
          ? parseInt(args.continuationToken, 10)
          : 0;
        const useDelimiter = args.delimiter === "/";

        const allItems = await storage.list(prefix, {
          recursive: !useDelimiter,
          filesOnly: false,
        });

        const objects: Array<{
          key: string;
          size: number;
          lastModified: string;
          etag: string;
        }> = [];

        const commonPrefixes: string[] = [];
        const seenPrefixes = new Set<string>();

        for (const item of allItems) {
          if (item.isDirectory) {
            if (useDelimiter) {
              const folderPath = item.path.endsWith("/")
                ? item.path
                : item.path + "/";
              if (!seenPrefixes.has(folderPath)) {
                seenPrefixes.add(folderPath);
                commonPrefixes.push(folderPath);
              }
            }
          } else {
            objects.push({
              key: item.path,
              size: item.size,
              lastModified: item.updated_at || new Date().toISOString(),
              etag: `"${item.id}"`,
            });
          }
        }

        const paginatedObjects = objects.slice(offset, offset + maxKeys);
        const hasMore = offset + maxKeys < objects.length;

        const result = {
          objects: paginatedObjects,
          commonPrefixes: useDelimiter ? commonPrefixes : undefined,
          isTruncated: hasMore,
          nextContinuationToken: hasMore ? String(offset + maxKeys) : undefined,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error: ${(error as Error).message}` },
          ],
          isError: true,
        };
      }
    }),
  );

  // GET_OBJECT_METADATA - Get file metadata
  server.registerTool(
    "GET_OBJECT_METADATA",
    {
      title: "Get Object Metadata",
      description: "Get metadata for a file (size, type, modified time).",
      inputSchema: {
        key: z.string().describe("Object key/path to get metadata for"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging(
      "GET_OBJECT_METADATA",
      async (args): Promise<CallToolResult> => {
        try {
          const metadata = await storage.getMetadata(args.key);

          const result = {
            contentType: metadata.mimeType,
            contentLength: metadata.size,
            lastModified: metadata.updated_at || new Date().toISOString(),
            etag: `"${metadata.id}"`,
            metadata: {},
          };

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        } catch (error) {
          return {
            content: [
              { type: "text", text: `Error: ${(error as Error).message}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  // GET_PRESIGNED_URL - Return HTTP URL for file download
  server.registerTool(
    "GET_PRESIGNED_URL",
    {
      title: "Get Presigned URL",
      description:
        "Get a URL for downloading a file. Returns an HTTP URL served by the mesh server.",
      inputSchema: {
        key: z.string().describe("Object key/path to generate URL for"),
        expiresIn: z
          .number()
          .optional()
          .describe("Ignored for local filesystem"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("GET_PRESIGNED_URL", async (args): Promise<CallToolResult> => {
      try {
        storage.resolvePath(args.key);

        const encodedKey = encodeURIComponent(args.key);
        const result = {
          url: `${baseFileUrl}/${encodedKey}`,
          expiresIn: 3600,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error: ${(error as Error).message}` },
          ],
          isError: true,
        };
      }
    }),
  );

  // PUT_PRESIGNED_URL - Upload instructions for local filesystem
  server.registerTool(
    "PUT_PRESIGNED_URL",
    {
      title: "Put Presigned URL",
      description:
        "Get a URL for uploading a file. For local filesystem, use bash to write files directly.",
      inputSchema: {
        key: z.string().describe("Object key/path for the upload"),
        expiresIn: z
          .number()
          .optional()
          .describe("Ignored for local filesystem"),
        contentType: z.string().optional().describe("MIME type (optional)"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("PUT_PRESIGNED_URL", async (args): Promise<CallToolResult> => {
      const encodedKey = encodeURIComponent(args.key);
      const result = {
        url: `${baseFileUrl}/${encodedKey}`,
        expiresIn: 3600,
        _note: "Use bash to write content to this path directly",
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }),
  );

  // DELETE_OBJECT - Delete a single file
  server.registerTool(
    "DELETE_OBJECT",
    {
      title: "Delete Object",
      description: "Delete a single file or empty directory.",
      inputSchema: {
        key: z.string().describe("Object key/path to delete"),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
      },
    },
    withLogging("DELETE_OBJECT", async (args): Promise<CallToolResult> => {
      try {
        await storage.delete(args.key, false);

        const result = { success: true, key: args.key };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const result = {
          success: false,
          key: args.key,
          error: (error as Error).message,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }
    }),
  );

  // DELETE_OBJECTS - Batch delete files
  server.registerTool(
    "DELETE_OBJECTS",
    {
      title: "Delete Objects",
      description: "Delete multiple files in batch.",
      inputSchema: {
        keys: z
          .array(z.string())
          .max(1000)
          .describe("Array of object keys/paths to delete"),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
      },
    },
    withLogging("DELETE_OBJECTS", async (args): Promise<CallToolResult> => {
      const deleted: string[] = [];
      const errors: Array<{ key: string; message: string }> = [];

      for (const key of args.keys) {
        try {
          await storage.delete(key, false);
          deleted.push(key);
        } catch (error) {
          errors.push({
            key,
            message: (error as Error).message,
          });
        }
      }

      const result = { deleted, errors };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }),
  );
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Generate a simple diff between two strings
 */
function generateDiff(
  path: string,
  original: string,
  modified: string,
): string {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];

  const maxLen = Math.max(originalLines.length, modifiedLines.length);
  let inHunk = false;
  let hunkStart = 0;
  let hunkLines: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const orig = originalLines[i];
    const mod = modifiedLines[i];

    if (orig !== mod) {
      if (!inHunk) {
        inHunk = true;
        hunkStart = i + 1;
        if (i > 0) hunkLines.push(` ${originalLines[i - 1]}`);
      }

      if (orig !== undefined) {
        hunkLines.push(`-${orig}`);
      }
      if (mod !== undefined) {
        hunkLines.push(`+${mod}`);
      }
    } else if (inHunk) {
      hunkLines.push(` ${orig}`);
      lines.push(
        `@@ -${hunkStart},${hunkLines.length} +${hunkStart},${hunkLines.length} @@`,
      );
      lines.push(...hunkLines);
      hunkLines = [];
      inHunk = false;
    }
  }

  if (hunkLines.length > 0) {
    lines.push(
      `@@ -${hunkStart},${hunkLines.length} +${hunkStart},${hunkLines.length} @@`,
    );
    lines.push(...hunkLines);
  }

  return lines.join("\n");
}
