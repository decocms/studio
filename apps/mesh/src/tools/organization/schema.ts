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

const ModelSlotSchema = z
  .object({
    keyId: z.string(),
    modelId: z.string(),
    title: z.string().optional(),
  })
  .nullable();

export const SimpleModeTierSchema = z.enum([
  "fast",
  "smart",
  "thinking",
  "image",
  "web_research",
]);

export type SimpleModeTier = z.infer<typeof SimpleModeTierSchema>;

/**
 * Chat-only tier subset used by automations.
 * Automations only need to pick between the three chat tiers
 * (fast/smart/thinking) — image and web_research are not applicable.
 */
export const ChatTierSchema = z.enum(["fast", "smart", "thinking"]);

export type ChatTier = z.infer<typeof ChatTierSchema>;

export const SimpleModeConfigSchema = z.object({
  tiers: z.object({
    fast: ModelSlotSchema,
    smart: ModelSlotSchema,
    thinking: ModelSlotSchema,
    image: ModelSlotSchema,
    web_research: ModelSlotSchema,
  }),
});

export type SimpleModeConfig = z.infer<typeof SimpleModeConfigSchema>;

/**
 * Default home agents config schema - matches DefaultHomeAgentsConfig from storage/types.ts.
 *
 * Each entry is a custom virtual MCP agent id (UUID). The home view renders
 * these tiles in order, capped at the home view's display limit.
 */
export const DefaultHomeAgentsConfigSchema = z.object({
  ids: z
    .array(z.string())
    .describe(
      "Ordered list of custom virtual MCP agent ids to show on the home view.",
    ),
});

export type DefaultHomeAgentsConfig = z.infer<
  typeof DefaultHomeAgentsConfigSchema
>;

/**
 * Observational agent config - per-org agent that observes idle threads.
 */
export const ObservationalConfigSchema = z.object({
  agentId: z
    .string()
    .describe(
      "Virtual MCP (agent) id that observes idle threads. Empty string disables observation.",
    ),
  skipAgentIds: z
    .array(z.string())
    .default([])
    .describe("Agent ids whose threads the observer ignores."),
  model: ModelSlotSchema.default(null).describe(
    "Specific model the observer runs with (exact credential + model). When null, falls back to the org's fast tier.",
  ),
  configuredAt: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "ISO timestamp the observer was (re)enabled; the sweep only observes threads active at/after it. Set automatically server-side — observation is forward-only, never a history backfill.",
    ),
});

export type ObservationalConfig = z.infer<typeof ObservationalConfigSchema>;

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
