/**
 * Organization Settings Schema
 *
 * Shared zod schemas for organization settings tools.
 * These schemas match the TypeScript interfaces defined in storage/types.ts
 */

import { z } from "zod";

/**
 * Sidebar item schema - matches SidebarItem interface from storage/types.ts
 */
export const SidebarItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  icon: z.string(),
});

export type SidebarItem = z.infer<typeof SidebarItemSchema>;

/**
 * Registry config schema - matches RegistryConfig interface from storage/types.ts
 *
 * Controls which registries are visible in the store and which individual MCPs are blocked.
 * When null/absent, defaults to Deco Store enabled with nothing blocked.
 */
export const RegistryConfigSchema = z.object({
  registries: z
    .record(z.string(), z.object({ enabled: z.boolean() }))
    .describe(
      "Per-registry enabled/disabled state. Key is connection ID. Absent registries are treated as enabled.",
    ),
  blockedMcps: z
    .array(z.string())
    .describe("List of MCP app_name or app_id values to hide from the store."),
});

export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;

/**
 * Model slot schema — a concrete model selection (provider key + model).
 * Matches SimpleModeModelSlot interface from storage/types.ts.
 */
const ModelSlotSchema = z
  .object({
    keyId: z.string(),
    modelId: z.string(),
    title: z.string().optional(),
  })
  .nullable();

/**
 * Simple Model Mode configuration schema.
 * Matches SimpleModeConfig interface from storage/types.ts.
 *
 * When the org enables Simple Mode, members see a Fast/Smart/Thinking
 * toggle instead of the full model picker, and image/webResearch default
 * to the models picked here.
 */
export const SimpleModeConfigSchema = z.object({
  enabled: z.boolean(),
  chat: z.object({
    fast: ModelSlotSchema,
    smart: ModelSlotSchema,
    thinking: ModelSlotSchema,
  }),
  image: ModelSlotSchema,
  webResearch: ModelSlotSchema,
});

export type SimpleModeConfig = z.infer<typeof SimpleModeConfigSchema>;

/**
 * Default home agents config schema - matches DefaultHomeAgentsConfig from storage/types.ts.
 *
 * Each entry is either a `WELL_KNOWN_AGENT_TEMPLATES` template id (e.g. "site-editor",
 * "ai-image") or a custom virtual MCP agent id (UUID). The home view renders these
 * tiles in order, capped at the home view's display limit.
 */
export const DefaultHomeAgentsConfigSchema = z.object({
  ids: z
    .array(z.string())
    .describe(
      "Ordered list of agent ids to show on the home view. Mix of well-known template ids and custom virtual MCP ids.",
    ),
});

export type DefaultHomeAgentsConfig = z.infer<
  typeof DefaultHomeAgentsConfigSchema
>;

/**
 * Brand context schema - org-scoped company profile
 */
export const BrandContextSchema = z.object({
  id: z.string().describe("Brand context ID"),
  name: z.string().describe("Company name"),
  domain: z.string().describe("Company domain (e.g. example.com)"),
  overview: z.string().describe("Company overview / description"),
  logo: z.string().nullable().optional().describe("Logo URL"),
  favicon: z.string().nullable().optional().describe("Favicon URL"),
  ogImage: z.string().nullable().optional().describe("OG image URL"),
  fonts: z
    .object({
      heading: z.string().optional().describe("Font family for headings"),
      body: z.string().optional().describe("Font family for body text"),
      code: z.string().optional().describe("Font family for code / monospace"),
    })
    .nullable()
    .optional()
    .describe("Font families by semantic role"),
  colors: z
    .object({
      primary: z.string().optional().describe("Primary brand color (hex)"),
      secondary: z.string().optional().describe("Secondary brand color (hex)"),
      accent: z.string().optional().describe("Accent / highlight color (hex)"),
      background: z.string().optional().describe("Background color (hex)"),
      foreground: z
        .string()
        .optional()
        .describe("Foreground / text color (hex)"),
    })
    .nullable()
    .optional()
    .describe("Semantic color palette"),
  images: z
    .array(z.record(z.string(), z.unknown()))
    .nullable()
    .optional()
    .describe("Brand images"),
  metadata: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      "Extra design tokens (typography, components, spacing, layout, tone, etc.)",
    ),
  archivedAt: z
    .string()
    .nullable()
    .optional()
    .describe("Archive timestamp (null to unarchive)"),
  isDefault: z
    .boolean()
    .optional()
    .describe("Whether this is the default brand for the organization"),
});

export type BrandContextInput = z.infer<typeof BrandContextSchema>;
