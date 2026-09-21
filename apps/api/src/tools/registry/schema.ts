import { CollectionListInputSchema } from "@decocms/bindings/collections";
import { z } from "zod";

// Preserve MCP server.json extensions through Zod and MCP output validation.
const RegistryServerSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    websiteUrl: z.string().optional(),
    icons: z
      .array(z.object({ src: z.string() }).catchall(z.unknown()))
      .optional(),
    remotes: z
      .array(
        z
          .object({
            type: z.string().optional(),
            url: z.string().optional(),
            name: z.string().optional(),
            title: z.string().optional(),
            description: z.string().optional(),
          })
          .catchall(z.unknown()),
      )
      .optional(),
    packages: z
      .array(
        z
          .object({
            identifier: z.string(),
            version: z.string().optional(),
          })
          .catchall(z.unknown()),
      )
      .optional(),
    repository: z
      .object({
        url: z.string().optional(),
        source: z.string().optional(),
        subfolder: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());

const RegistryToolSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable().optional(),
  })
  .catchall(z.unknown());

const StudioRegistryMetadataSchema = z
  .object({
    verified: z.boolean().optional(),
    official: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    friendly_name: z.string().nullable().optional(),
    short_description: z.string().max(160).nullable().optional(),
    owner: z.string().nullable().optional(),
    readme: z.string().max(50000).nullable().optional(),
    // Plain string (not `.url()`): `.url()` advertises JSON Schema
    // `format: "uri"`, which Ajv (in MCP clients) enforces more strictly
    // than Zod's `new URL()` — rejecting otherwise-valid URLs with spaces
    // or non-ASCII chars. Matches every other URL field in this schema.
    readme_url: z.string().nullable().optional(),
    has_remote: z.boolean().optional(),
    has_oauth: z.boolean().optional(),
    tools: z.array(RegistryToolSchema).optional(),
  })
  .catchall(z.unknown());

const RegistryItemMetaSchema = z
  .object({
    "mcp.studio": StudioRegistryMetadataSchema.optional(),
    /** @deprecated Compatibility with existing registry records. */
    "mcp.mesh": StudioRegistryMetadataSchema.optional(),
  })
  .catchall(z.unknown());

export const RegistryItemSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    title: z.string(),
    description: z.string().nullable().optional(),
    _meta: RegistryItemMetaSchema.optional(),
    server: RegistryServerSchema,
    is_public: z.boolean().optional(),
    is_unlisted: z.boolean().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    created_by: z.string().optional(),
  })
  .catchall(z.unknown());

export const RegistryListInputSchema = CollectionListInputSchema.extend({
  tags: z
    .array(z.string())
    .optional()
    .describe("Filter by tags (AND semantics)"),
  categories: z
    .array(z.string())
    .optional()
    .describe("Filter by categories (AND semantics)"),
  cursor: z.string().optional().describe("Pagination cursor"),
}).describe("List registry items with optional filtering and pagination.");

export const RegistryListOutputSchema = z.object({
  items: z.array(RegistryItemSchema),
  totalCount: z.number(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
});

export const RegistryGetInputSchema = z
  .object({
    id: z.string().optional().describe("Registry item ID"),
    name: z.string().optional().describe("Registry item name (alias for id)"),
  })
  .refine((data) => data.id || data.name, {
    message: "At least one of 'id' or 'name' is required",
  })
  .describe("Get a registry item by ID or name.");

export const RegistryGetOutputSchema = z.object({
  item: RegistryItemSchema.nullable(),
});

export const RegistryFiltersOutputSchema = z.object({
  tags: z.array(z.object({ value: z.string(), count: z.number() })),
  categories: z.array(z.object({ value: z.string(), count: z.number() })),
});

export const RegistrySearchInputSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe("Free-text search across id, title, description, server name"),
    tags: z.array(z.string()).optional().describe("Filter by tags (AND)"),
    categories: z
      .array(z.string())
      .optional()
      .describe("Filter by categories (AND)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max results (default 20)"),
    cursor: z.string().optional().describe("Pagination cursor"),
  })
  .describe(
    "Lightweight search returning minimal fields (id, title, tags, categories, is_public).",
  );

const RegistrySearchItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  categories: z.array(z.string()),
  is_public: z.boolean(),
  is_unlisted: z.boolean(),
});

export const RegistrySearchOutputSchema = z.object({
  items: z.array(RegistrySearchItemSchema),
  totalCount: z.number(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
});
