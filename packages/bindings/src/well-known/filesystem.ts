/**
 * Filesystem Well-Known Binding
 *
 * Defines the interface for agent-oriented filesystem operations backed by S3-compatible storage.
 * Unlike OBJECT_STORAGE_BINDING (which uses presigned URLs for browser/UI use),
 * this binding provides inline content access designed for AI agents.
 *
 * This binding includes:
 * - FS_READ: Read file content inline (text or base64 for binary)
 * - FS_WRITE: Write file content inline
 * - FS_LIST: List files and directories with pattern filtering
 * - FS_DELETE: Delete a single file
 * - FS_METADATA: Get file metadata (size, content type, etc.)
 */

import { z } from "zod";
import type { Binder, ToolBinder } from "../core/binder";

// ============================================================================
// Tool Schemas
// ============================================================================

/**
 * FS_READ - Read file content inline
 *
 * Returns content directly for text files and small binary files (as base64).
 * For files exceeding the size limit, returns an error with file metadata.
 */
const FsReadInputSchema = z.object({
  path: z.string().describe("File path to read (e.g., 'docs/readme.md')"),
  offset: z
    .number()
    .optional()
    .describe(
      "Byte offset to start reading from (for partial reads of large files)",
    ),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of bytes to read (for partial reads)"),
});

const FsReadOutputSchema = z.object({
  content: z
    .string()
    .optional()
    .describe(
      "File content as text (for text files) or base64 (for small binary files)",
    ),
  encoding: z
    .enum(["utf-8", "base64"])
    .optional()
    .describe("Content encoding: utf-8 for text, base64 for binary"),
  contentType: z.string().optional().describe("MIME type of the file"),
  size: z.number().describe("Total file size in bytes"),
  error: z
    .enum(["FILE_NOT_FOUND", "FILE_TOO_LARGE"])
    .optional()
    .describe("Error code if file cannot be read inline"),
});

export type FsReadInput = z.infer<typeof FsReadInputSchema>;
export type FsReadOutput = z.infer<typeof FsReadOutputSchema>;

export { FsReadInputSchema, FsReadOutputSchema };

/**
 * FS_WRITE - Write file content inline
 *
 * Creates or overwrites a file with the provided content.
 */
const FsWriteInputSchema = z.object({
  path: z.string().describe("File path to write to (e.g., 'docs/readme.md')"),
  content: z.string().describe("File content to write"),
  encoding: z
    .enum(["utf-8", "base64"])
    .optional()
    .default("utf-8")
    .describe("Content encoding: utf-8 for text (default), base64 for binary"),
  contentType: z
    .string()
    .optional()
    .describe(
      "MIME type for the file (auto-detected from extension if omitted)",
    ),
});

const FsWriteOutputSchema = z.object({
  path: z.string().describe("Path of the written file"),
  size: z.number().describe("Size of the written file in bytes"),
});

export type FsWriteInput = z.infer<typeof FsWriteInputSchema>;
export type FsWriteOutput = z.infer<typeof FsWriteOutputSchema>;

export { FsWriteInputSchema, FsWriteOutputSchema };

/**
 * FS_LIST - List files and directories
 *
 * Lists entries at a given path with optional pattern filtering.
 * Uses S3 prefix/delimiter semantics to simulate directory listing.
 */
const FsListInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory path to list (e.g., 'docs/'). Defaults to root."),
  pattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern to filter results by key name (e.g., '*.md'). Applied to key names only, not content.",
    ),
  continuationToken: z
    .string()
    .optional()
    .describe("Token for pagination from previous response"),
  maxKeys: z
    .number()
    .optional()
    .default(100)
    .describe("Maximum number of entries to return (default: 100, max: 1000)"),
});

const FsListOutputSchema = z.object({
  entries: z
    .array(
      z.object({
        path: z.string().describe("File or directory path"),
        type: z.enum(["file", "directory"]).describe("Entry type"),
        size: z.number().optional().describe("File size in bytes (files only)"),
        lastModified: z
          .string()
          .optional()
          .describe("Last modified timestamp (files only)"),
      }),
    )
    .describe("List of file and directory entries"),
  nextContinuationToken: z
    .string()
    .optional()
    .describe("Token for fetching next page of results"),
  isTruncated: z.boolean().describe("Whether there are more results available"),
});

export type FsListInput = z.infer<typeof FsListInputSchema>;
export type FsListOutput = z.infer<typeof FsListOutputSchema>;

export { FsListInputSchema, FsListOutputSchema };

/**
 * FS_DELETE - Delete a single file
 */
const FsDeleteInputSchema = z.object({
  path: z.string().describe("File path to delete"),
});

const FsDeleteOutputSchema = z.object({
  success: z.boolean().describe("Whether the deletion was successful"),
  path: z.string().describe("Path of the deleted file"),
});

export type FsDeleteInput = z.infer<typeof FsDeleteInputSchema>;
export type FsDeleteOutput = z.infer<typeof FsDeleteOutputSchema>;

export { FsDeleteInputSchema, FsDeleteOutputSchema };

/**
 * FS_METADATA - Get file metadata
 */
const FsMetadataInputSchema = z.object({
  path: z.string().describe("File path to get metadata for"),
});

const FsMetadataOutputSchema = z.object({
  size: z.number().describe("File size in bytes"),
  contentType: z.string().optional().describe("MIME type of the file"),
  lastModified: z.string().describe("Last modified timestamp"),
  etag: z.string().describe("Entity tag for the file"),
});

export type FsMetadataInput = z.infer<typeof FsMetadataInputSchema>;
export type FsMetadataOutput = z.infer<typeof FsMetadataOutputSchema>;

export { FsMetadataInputSchema, FsMetadataOutputSchema };

// ============================================================================
// Binding Definition
// ============================================================================

/**
 * Filesystem Binding
 *
 * Agent-oriented filesystem interface backed by S3-compatible storage.
 * Provides inline content access (read/write file content directly in tool calls)
 * as opposed to OBJECT_STORAGE_BINDING which uses presigned URLs.
 *
 * Required tools:
 * - FS_READ: Read file content inline
 * - FS_WRITE: Write file content inline
 * - FS_LIST: List files and directories
 * - FS_DELETE: Delete a file
 * - FS_METADATA: Get file metadata
 */
export const FILESYSTEM_BINDING = [
  {
    name: "FS_READ" as const,
    inputSchema: FsReadInputSchema,
    outputSchema: FsReadOutputSchema,
  } satisfies ToolBinder<"FS_READ", FsReadInput, FsReadOutput>,
  {
    name: "FS_WRITE" as const,
    inputSchema: FsWriteInputSchema,
    outputSchema: FsWriteOutputSchema,
  } satisfies ToolBinder<"FS_WRITE", FsWriteInput, FsWriteOutput>,
  {
    name: "FS_LIST" as const,
    inputSchema: FsListInputSchema,
    outputSchema: FsListOutputSchema,
  } satisfies ToolBinder<"FS_LIST", FsListInput, FsListOutput>,
  {
    name: "FS_DELETE" as const,
    inputSchema: FsDeleteInputSchema,
    outputSchema: FsDeleteOutputSchema,
  } satisfies ToolBinder<"FS_DELETE", FsDeleteInput, FsDeleteOutput>,
  {
    name: "FS_METADATA" as const,
    inputSchema: FsMetadataInputSchema,
    outputSchema: FsMetadataOutputSchema,
  } satisfies ToolBinder<"FS_METADATA", FsMetadataInput, FsMetadataOutput>,
] as const satisfies Binder;

export type FilesystemBinding = typeof FILESYSTEM_BINDING;
