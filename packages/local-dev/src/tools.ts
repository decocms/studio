/**
 * MCP Local Dev - Tool Definitions
 *
 * Filesystem tools (LDV-02) and OBJECT_STORAGE_BINDING tools (LDV-03).
 *
 * Transplanted from local-fs with the following changes:
 * - No git tools (superseded by bash tool in plan 03)
 * - No EXEC / DENO_TASK (superseded by bash tool in plan 03)
 * - GET_PRESIGNED_URL returns http://localhost:<port>/files/ URLs (not file://)
 * - registerTools signature: (server, storage, port)
 *
 * NOTE: The HTTP /files/<key> handler (served at the port) must call
 * storage.resolvePath(key) and verify the result starts with storage.root
 * before serving. This prevents path traversal attacks on presigned URLs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  LocalFileStorage,
  type FileEntity,
  getExtensionFromMimeType,
} from "./storage.ts";
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
 * Register all filesystem and object storage tools on an MCP server.
 *
 * @param server - The MCP server instance
 * @param storage - The LocalFileStorage instance (scopes all paths to root)
 * @param port - The HTTP port for presigned URL construction (GET_PRESIGNED_URL)
 */
export function registerTools(
  server: McpServer,
  storage: LocalFileStorage,
  port: number,
) {
  // ============================================================
  // OFFICIAL MCP FILESYSTEM TOOLS (LDV-02)
  // Following exact schema from modelcontextprotocol/servers
  // ============================================================

  // read_file - primary file reading tool (official MCP name)
  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description:
        "Read the complete contents of a file from the file system. " +
        "Handles various text encodings and provides detailed error messages " +
        "if the file cannot be read. Use this tool when you need to examine " +
        "the contents of a single file. Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path to the file to read"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("read_file", async (args) =>
      readTextFileHandler(storage, args),
    ),
  );

  // read_text_file - alias for read_file with head/tail support
  server.registerTool(
    "read_text_file",
    {
      title: "Read Text File",
      description:
        "Read the complete contents of a file from the file system as text. " +
        "Handles various text encodings and provides detailed error messages " +
        "if the file cannot be read. Use this tool when you need to examine " +
        "the contents of a single file. Use the 'head' parameter to read only " +
        "the first N lines of a file, or the 'tail' parameter to read only " +
        "the last N lines of a file. Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path to the file to read"),
        tail: z
          .number()
          .optional()
          .describe("If provided, returns only the last N lines of the file"),
        head: z
          .number()
          .optional()
          .describe("If provided, returns only the first N lines of the file"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("read_text_file", async (args) =>
      readTextFileHandler(storage, args),
    ),
  );

  // read_media_file - read binary files as base64
  server.registerTool(
    "read_media_file",
    {
      title: "Read Media File",
      description:
        "Read an image or audio file. Returns the base64 encoded data and MIME type. " +
        "Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path to the media file to read"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("read_media_file", async (args): Promise<CallToolResult> => {
      try {
        const result = await storage.read(args.path, "base64");
        const mimeType = result.metadata.mimeType;
        const type = mimeType.startsWith("image/")
          ? "image"
          : mimeType.startsWith("audio/")
            ? "audio"
            : "blob";

        const contentItem = {
          type: type as "image" | "audio",
          data: result.content,
          mimeType,
        };

        // NOTE: Do NOT include structuredContent for media files
        // The base64 data would get serialized to JSON and cause token explosion
        return {
          content: [contentItem],
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

  // read_multiple_files - read multiple files at once
  server.registerTool(
    "read_multiple_files",
    {
      title: "Read Multiple Files",
      description:
        "Read the contents of multiple files simultaneously. This is more " +
        "efficient than reading files one by one when you need to analyze " +
        "or compare multiple files. Each file's content is returned with its " +
        "path as a reference. Failed reads for individual files won't stop " +
        "the entire operation. Only works within allowed directories.",
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .describe(
            "Array of file paths to read. Each path must be a string pointing to a valid file.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging(
      "read_multiple_files",
      async (args): Promise<CallToolResult> => {
        const results = await Promise.all(
          args.paths.map(async (filePath: string) => {
            try {
              const result = await storage.read(filePath, "utf-8");
              return `${filePath}:\n${result.content}\n`;
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              return `${filePath}: Error - ${errorMessage}`;
            }
          }),
        );
        const text = results.join("\n---\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { content: text },
        };
      },
    ),
  );

  // write_file - write content to a file
  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description:
        "Create a new file or completely overwrite an existing file with new content. " +
        "Use with caution as it will overwrite existing files without warning. " +
        "Handles text content with proper encoding. Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path where the file should be written"),
        content: z.string().describe("Content to write to the file"),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
      },
    },
    withLogging("write_file", async (args): Promise<CallToolResult> => {
      try {
        await storage.write(args.path, args.content, {
          encoding: "utf-8",
          createParents: true,
          overwrite: true,
        });
        const text = `Successfully wrote to ${args.path}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { content: text },
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

  // edit_file - make search/replace edits with diff preview
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

  // create_directory - create directories
  server.registerTool(
    "create_directory",
    {
      title: "Create Directory",
      description:
        "Create a new directory or ensure a directory exists. Can create multiple " +
        "nested directories in one operation. If the directory already exists, " +
        "this operation will succeed silently. Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path of the directory to create"),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
    },
    withLogging("create_directory", async (args): Promise<CallToolResult> => {
      try {
        await storage.mkdir(args.path, true);
        const text = `Successfully created directory ${args.path}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { content: text },
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

  // list_directory - simple directory listing
  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description:
        "Get a detailed listing of all files and directories in a specified path. " +
        "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
        "prefixes. Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path of the directory to list"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("list_directory", async (args): Promise<CallToolResult> => {
      try {
        const items = await storage.list(args.path);
        const formatted = items
          .map(
            (entry) =>
              `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.title}`,
          )
          .join("\n");
        return {
          content: [{ type: "text", text: formatted || "Empty directory" }],
          structuredContent: { content: formatted },
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

  // list_directory_with_sizes - listing with file sizes
  server.registerTool(
    "list_directory_with_sizes",
    {
      title: "List Directory with Sizes",
      description:
        "Get a detailed listing of all files and directories in a specified path, including sizes. " +
        "Results clearly distinguish between files and directories. " +
        "Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path of the directory to list"),
        sortBy: z
          .enum(["name", "size"])
          .optional()
          .default("name")
          .describe("Sort entries by name or size"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging(
      "list_directory_with_sizes",
      async (args): Promise<CallToolResult> => {
        try {
          const items = await storage.list(args.path);

          // Sort entries
          const sortedItems = [...items].sort((a, b) => {
            if (args.sortBy === "size") {
              return b.size - a.size;
            }
            return a.title.localeCompare(b.title);
          });

          // Format output
          const formatted = sortedItems
            .map(
              (entry) =>
                `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.title.padEnd(30)} ${
                  entry.isDirectory ? "" : formatSize(entry.size).padStart(10)
                }`,
            )
            .join("\n");

          // Summary
          const totalFiles = items.filter((e) => !e.isDirectory).length;
          const totalDirs = items.filter((e) => e.isDirectory).length;
          const totalSize = items.reduce(
            (sum, entry) => sum + (entry.isDirectory ? 0 : entry.size),
            0,
          );

          const summary = `\nTotal: ${totalFiles} files, ${totalDirs} directories\nCombined size: ${formatSize(totalSize)}`;
          const text = formatted + summary;

          return {
            content: [{ type: "text", text }],
            structuredContent: { content: text },
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

  // directory_tree - recursive tree view as JSON
  server.registerTool(
    "directory_tree",
    {
      title: "Directory Tree",
      description:
        "Get a recursive tree view of files and directories as a JSON structure. " +
        "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
        "Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path of the root directory for the tree"),
        excludePatterns: z
          .array(z.string())
          .optional()
          .default([])
          .describe("Glob patterns to exclude from the tree"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("directory_tree", async (args): Promise<CallToolResult> => {
      try {
        const tree = await buildDirectoryTree(
          storage,
          args.path,
          args.excludePatterns,
        );
        const text = JSON.stringify(tree, null, 2);
        return {
          content: [{ type: "text", text }],
          structuredContent: { content: text },
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

  // move_file - move or rename files
  server.registerTool(
    "move_file",
    {
      title: "Move File",
      description:
        "Move or rename files and directories. Can move files between directories " +
        "and rename them in a single operation. If the destination exists, the " +
        "operation will fail. Only works within allowed directories.",
      inputSchema: {
        source: z.string().describe("Source path of the file or directory"),
        destination: z.string().describe("Destination path"),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      },
    },
    withLogging("move_file", async (args): Promise<CallToolResult> => {
      try {
        await storage.move(args.source, args.destination, false);
        const text = `Successfully moved ${args.source} to ${args.destination}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { content: text },
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

  // search_files - search with glob patterns
  server.registerTool(
    "search_files",
    {
      title: "Search Files",
      description:
        "Recursively search for files and directories matching a pattern. " +
        "Searches file names (not content). Returns full paths to all matching items. " +
        "Only searches within allowed directories.",
      inputSchema: {
        path: z.string().describe("Starting directory for the search"),
        pattern: z
          .string()
          .describe("Search pattern (supports * and ** wildcards)"),
        excludePatterns: z
          .array(z.string())
          .optional()
          .default([])
          .describe("Patterns to exclude from search"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("search_files", async (args): Promise<CallToolResult> => {
      try {
        const results = await searchFiles(
          storage,
          args.path,
          args.pattern,
          args.excludePatterns,
        );
        const text =
          results.length > 0 ? results.join("\n") : "No matches found";
        return {
          content: [{ type: "text", text }],
          structuredContent: { content: text, matches: results },
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

  // get_file_info - get detailed file metadata
  server.registerTool(
    "get_file_info",
    {
      title: "Get File Info",
      description:
        "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
        "information including size, creation time, last modified time, and type. " +
        "Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path to the file or directory"),
      },
      annotations: { readOnlyHint: true },
    },
    withLogging("get_file_info", async (args): Promise<CallToolResult> => {
      try {
        const metadata = await storage.getMetadata(args.path);
        const info = {
          path: metadata.path,
          type: metadata.isDirectory ? "directory" : "file",
          size: metadata.size,
          sizeFormatted: formatSize(metadata.size),
          mimeType: metadata.mimeType,
          created: metadata.created_at,
          modified: metadata.updated_at,
        };
        const text = Object.entries(info)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: info,
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

  // list_allowed_directories - show the root directory
  server.registerTool(
    "list_allowed_directories",
    {
      title: "List Allowed Directories",
      description:
        "Returns the list of directories that this server is allowed to access. " +
        "Use this to understand which directories are available.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withLogging(
      "list_allowed_directories",
      async (): Promise<CallToolResult> => {
        const text = `Allowed directories:\n${storage.root}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { directories: [storage.root] },
        };
      },
    ),
  );

  // ============================================================
  // ADDITIONAL TOOLS (not in official MCP spec, but useful)
  // ============================================================

  // delete_file - delete files or directories
  server.registerTool(
    "delete_file",
    {
      title: "Delete File",
      description:
        "Delete a file or directory. Use recursive=true to delete non-empty directories. " +
        "Use with caution as this operation cannot be undone. Only works within allowed directories.",
      inputSchema: {
        path: z.string().describe("Path to the file or directory to delete"),
        recursive: z
          .boolean()
          .default(false)
          .describe(
            "If true, recursively delete directories and their contents",
          ),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
      },
    },
    withLogging("delete_file", async (args): Promise<CallToolResult> => {
      try {
        await storage.delete(args.path, args.recursive);
        const text = `Successfully deleted ${args.path}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { content: text },
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

  // copy_file - copy files
  server.registerTool(
    "copy_file",
    {
      title: "Copy File",
      description:
        "Copy a file to a new location. The destination must not exist unless overwrite is true. " +
        "Only works within allowed directories.",
      inputSchema: {
        source: z.string().describe("Source path of the file to copy"),
        destination: z.string().describe("Destination path for the copy"),
        overwrite: z
          .boolean()
          .default(false)
          .describe("If true, overwrite the destination if it exists"),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
    },
    withLogging("copy_file", async (args): Promise<CallToolResult> => {
      try {
        await storage.copy(args.source, args.destination, args.overwrite);
        const text = `Successfully copied ${args.source} to ${args.destination}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { content: text },
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

  // fetch_to_file - fetch URL and stream directly to disk
  server.registerTool(
    "fetch_to_file",
    {
      title: "Fetch URL to File",
      description:
        "Fetch content from a URL and save it directly to disk using streaming. " +
        "Content is streamed without loading into memory, making it efficient for large files. " +
        "Filename is extracted from URL path or Content-Disposition header. " +
        "File extension is intelligently determined from Content-Type when not in filename. " +
        "Perfect for downloading large datasets, images, or any remote content without " +
        "consuming context window tokens. Only works within allowed directories.",
      inputSchema: {
        url: z.string().describe("The URL to fetch content from"),
        filename: z
          .string()
          .optional()
          .describe(
            "Optional filename to save as. If not provided, extracted from URL or Content-Disposition header",
          ),
        directory: z
          .string()
          .default("")
          .describe(
            "Directory to save the file in (relative to storage root). Defaults to root.",
          ),
        overwrite: z
          .boolean()
          .default(false)
          .describe("If true, overwrite existing file"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional HTTP headers to send with the request (e.g., Authorization)",
          ),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      },
    },
    withLogging("fetch_to_file", async (args): Promise<CallToolResult> => {
      try {
        const fetchHeaders: Record<string, string> = {
          "User-Agent": "MCP-LocalDev/1.0",
          ...(args.headers || {}),
        };

        const response = await fetch(args.url, {
          headers: fetchHeaders,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error("Response has no body");
        }

        // Determine filename
        let filename = args.filename;

        if (!filename) {
          // Try Content-Disposition header first
          const disposition = response.headers.get("Content-Disposition");
          if (disposition) {
            const filenameMatch = disposition.match(
              /filename[*]?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i,
            );
            if (filenameMatch) {
              filename = decodeURIComponent(filenameMatch[1].trim());
            }
          }

          // Fall back to URL path
          if (!filename) {
            const urlObj = new URL(args.url);
            const pathParts = urlObj.pathname.split("/").filter(Boolean);
            filename =
              pathParts.length > 0
                ? pathParts[pathParts.length - 1]
                : "download";
          }
        }

        // Check if filename has extension, if not try to add from Content-Type
        const hasExtension = filename.includes(".");
        if (!hasExtension) {
          const contentType = response.headers.get("Content-Type");
          if (contentType) {
            const ext = getExtensionFromMimeType(contentType);
            if (ext) {
              filename = filename + ext;
            }
          }
        }

        // Sanitize filename
        filename = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");

        // Build full path
        const directory = args.directory || "";
        const fullPath = directory ? `${directory}/${filename}` : filename;

        // Stream to disk
        const result = await storage.writeStream(fullPath, response.body, {
          createParents: true,
          overwrite: args.overwrite,
        });

        const summary = {
          path: result.file.path,
          size: result.bytesWritten,
          sizeFormatted: formatSize(result.bytesWritten),
          mimeType: result.file.mimeType,
          url: args.url,
        };

        const text =
          `Successfully downloaded ${args.url}\n` +
          `Saved to: ${result.file.path}\n` +
          `Size: ${formatSize(result.bytesWritten)}`;

        return {
          content: [{ type: "text", text }],
          structuredContent: summary,
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

  // SKILLS_LIST - List available skills from the skills/ directory
  server.registerTool(
    "SKILLS_LIST",
    {
      title: "List Skills",
      description:
        "List available skills from the skills/ directory. " +
        "Each skill is defined by a SKILL.md file with YAML frontmatter.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withLogging("SKILLS_LIST", async (): Promise<CallToolResult> => {
      try {
        const { readdir, readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");

        const skillsDir = join(storage.root, "skills");
        const skills: Array<{
          id: string;
          name: string;
          description: string;
          path: string;
        }> = [];

        try {
          const entries = await readdir(skillsDir, { withFileTypes: true });

          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
              const skillPath = join(skillsDir, entry.name, "SKILL.md");
              try {
                const content = await readFile(skillPath, "utf-8");

                // Parse YAML frontmatter
                const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (frontmatterMatch) {
                  const frontmatter = frontmatterMatch[1];
                  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
                  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

                  skills.push({
                    id: entry.name,
                    name: nameMatch?.[1] || entry.name,
                    description: descMatch?.[1] || "",
                    path: `skills/${entry.name}/SKILL.md`,
                  });
                }
              } catch {
                // Skip if SKILL.md doesn't exist
              }
            }
          }
        } catch {
          // skills/ directory doesn't exist
        }

        const result = { skills };
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

  // ============================================================
  // OBJECT STORAGE BINDING TOOLS (LDV-03)
  // Implements OBJECT_STORAGE_BINDING for the Files plugin
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

        // List all items in the prefix directory
        const allItems = await storage.list(prefix, {
          recursive: !useDelimiter,
          filesOnly: false,
        });

        // Build response
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
              // Add as common prefix (folder)
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

        // Apply pagination
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

  // GET_PRESIGNED_URL - Return HTTP URL for local filesystem
  // CRITICAL FIX: Returns http://localhost:<port>/files/<key> instead of file:// URLs
  // file:// URLs do not work in browser contexts (Mesh UI cannot display them)
  // The /files/ HTTP handler in server.ts must use storage.resolvePath(key) and
  // verify the result starts with storage.root before serving (path traversal guard).
  server.registerTool(
    "GET_PRESIGNED_URL",
    {
      title: "Get Presigned URL",
      description:
        "Get a URL for downloading a file. Returns an HTTP URL served by the local-dev daemon.",
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
        // Validate the key resolves within the storage root (path traversal check)
        // This will throw if the key escapes the root
        storage.resolvePath(args.key);

        const encodedKey = encodeURIComponent(args.key);
        const result = {
          url: `http://localhost:${port}/files/${encodedKey}`,
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

  // PUT_PRESIGNED_URL - Return upload instructions for local filesystem
  server.registerTool(
    "PUT_PRESIGNED_URL",
    {
      title: "Put Presigned URL",
      description:
        "Get a URL for uploading a file. For local filesystem, returns instructions to use write_file tool.",
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
      // For local filesystem we serve files via HTTP, but PUT is not supported
      // Instruct callers to use write_file tool instead
      const encodedKey = encodeURIComponent(args.key);
      const result = {
        url: `http://localhost:${port}/files/${encodedKey}`,
        expiresIn: 3600,
        _note: "Use write_file tool to upload content to this path",
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

        const result = {
          success: true,
          key: args.key,
        };

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

  // GET_ROOT - Get the root folder path (for Task Runner integration)
  server.registerTool(
    "GET_ROOT",
    {
      title: "Get Root Path",
      description:
        "Get the root folder path that this MCP is serving. " +
        "Returns the absolute path to the workspace root directory.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withLogging("GET_ROOT", async (): Promise<CallToolResult> => {
      const result = { root: storage.root };
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
 * Handler for read_file and read_text_file
 */
async function readTextFileHandler(
  storage: LocalFileStorage,
  args: { path: string; head?: number; tail?: number },
): Promise<CallToolResult> {
  try {
    if (args.head && args.tail) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Cannot specify both head and tail parameters simultaneously",
          },
        ],
        isError: true,
      };
    }

    const result = await storage.read(args.path, "utf-8");
    let content = result.content;

    if (args.tail) {
      const lines = content.split("\n");
      content = lines.slice(-args.tail).join("\n");
    } else if (args.head) {
      const lines = content.split("\n");
      content = lines.slice(0, args.head).join("\n");
    }

    return {
      content: [{ type: "text" as const, text: content }],
      structuredContent: { content },
    };
  } catch (error) {
    return {
      content: [
        { type: "text" as const, text: `Error: ${(error as Error).message}` },
      ],
      isError: true,
    };
  }
}

/**
 * Format file size in human-readable format
 */
function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

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

  // Simple line-by-line diff
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
        // Add context before
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
      // Close hunk after context
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

/**
 * Build a recursive directory tree
 */
interface TreeEntry {
  name: string;
  type: "file" | "directory";
  children?: TreeEntry[];
}

async function buildDirectoryTree(
  storage: LocalFileStorage,
  path: string,
  excludePatterns: string[],
): Promise<TreeEntry[]> {
  const items = await storage.list(path);
  const result: TreeEntry[] = [];

  for (const item of items) {
    // Check exclusions
    const shouldExclude = excludePatterns.some((pattern) => {
      if (pattern.includes("*")) {
        return matchGlob(item.title, pattern);
      }
      return item.title === pattern;
    });

    if (shouldExclude) continue;

    const entry: TreeEntry = {
      name: item.title.split("/").pop() || item.title,
      type: item.isDirectory ? "directory" : "file",
    };

    if (item.isDirectory) {
      entry.children = await buildDirectoryTree(
        storage,
        item.path,
        excludePatterns,
      );
    }

    result.push(entry);
  }

  return result;
}

/**
 * Search for files matching a pattern
 */
async function searchFiles(
  storage: LocalFileStorage,
  basePath: string,
  pattern: string,
  excludePatterns: string[],
): Promise<string[]> {
  const items = await storage.list(basePath, { recursive: true });
  const results: string[] = [];

  for (const item of items) {
    // Check exclusions
    const shouldExclude = excludePatterns.some((p) => matchGlob(item.path, p));
    if (shouldExclude) continue;

    // Check pattern match
    if (matchGlob(item.path, pattern) || matchGlob(item.title, pattern)) {
      results.push(item.path);
    }
  }

  return results;
}

/**
 * Simple glob pattern matching
 */
function matchGlob(str: string, pattern: string): boolean {
  // Convert glob to regex
  const regex = pattern
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\./g, "\\.");

  return new RegExp(`^${regex}$`).test(str) || new RegExp(regex).test(str);
}
