/**
 * Demo Catalog
 *
 * Consolidated catalog of all available:
 * - MCP connections (verified and ready to use)
 * - Gateway templates
 *
 * Data sourced from Deco Store API (https://api.decocms.com/mcp/registry)
 */

import type { Connection, Gateway } from "./seeder";

// =============================================================================
// Well-Known Connections (installed by default in production)
// =============================================================================

// Note: Tools are fetched dynamically from the MCP servers (not mocked)
// This matches production behavior where fetchToolsFromMCP is called
export const WELL_KNOWN_CONNECTIONS = {
  meshMcp: {
    title: "Mesh MCP",
    description: "The MCP for the mesh API",
    icon: "https://assets.decocache.com/mcp/09e44283-f47d-4046-955f-816d227c626f/app.png",
    appName: "@deco/management-mcp",
    connectionUrl: "https://mesh-admin.decocms.com/mcp",
    connectionToken: null,
    metadata: { provider: "deco", decoHosted: true },
    tools: [], // Mesh MCP tools are dynamic, populated at runtime
  },

  mcpRegistry: {
    title: "MCP Registry",
    description: "Community MCP registry with thousands of handy MCPs",
    icon: "https://assets.decocache.com/decocms/cd7ca472-0f72-463a-b0de-6e44bdd0f9b4/mcp.png",
    appName: "mcp-registry",
    connectionUrl: "https://sites-registry.decocache.com/mcp",
    connectionToken: null,
    metadata: { provider: "deco", decoHosted: true },
    // Tools will be fetched dynamically from the server
  },

  decoStore: {
    title: "Deco Store",
    description: "Official deco MCP registry with curated integrations",
    icon: "https://assets.decocache.com/decocms/00ccf6c3-9e13-4517-83b0-75ab84554bb9/596364c63320075ca58483660156b6d9de9b526e.png",
    appName: "deco-registry",
    connectionUrl: "https://api.decocms.com/mcp/registry",
    connectionToken: null,
    metadata: { provider: "deco", decoHosted: true },
    // Tools will be fetched dynamically from the server
  },
} as const satisfies Record<string, Connection>;

export type WellKnownConnectionKey = keyof typeof WELL_KNOWN_CONNECTIONS;

// =============================================================================
// Connection Catalog (data from Deco Store)
// =============================================================================

export const CONNECTIONS = {
  // Development & Infrastructure
  github: {
    title: "GitHub",
    description:
      "GitHub MCP Server Official - Interact with GitHub platform through natural language. Manage repositories, issues, pull requests, analyze code, and automate workflows. This is the official MCP server from GitHub.",
    icon: "https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png",
    appName: "github/github-mcp-server",
    connectionUrl: "https://api.githubcopilot.com/mcp/",
    connectionToken: null,
    metadata: { provider: "github", requiresOAuth: true, official: true },
  },

  vercel: {
    title: "Vercel",
    description: "Frontend deployment and preview environments",
    icon: "https://vercel.com/favicon.ico",
    appName: "Vercel",
    connectionUrl: "https://mcp.vercel.com",
    connectionToken: null,
    metadata: { provider: "vercel", requiresOAuth: true, official: true },
  },

  supabase: {
    title: "Supabase",
    description: "Backend-as-a-service with real-time capabilities",
    icon: "https://supabase.com/favicon.ico",
    appName: "Supabase",
    connectionUrl: "https://mcp.supabase.com/mcp",
    connectionToken: null,
    metadata: { provider: "supabase", requiresOAuth: true, official: true },
  },

  prisma: {
    title: "Prisma",
    description: "ORM and database toolkit for schema management",
    icon: "https://prismalens.vercel.app/header/logo-dark.svg",
    appName: "Prisma",
    connectionUrl: "https://mcp.prisma.io/sse",
    connectionToken: null,
    metadata: { provider: "prisma", requiresOAuth: true, official: true },
  },

  cloudflare: {
    title: "Cloudflare",
    description: "Manage DNS, Workers, R2, and edge infrastructure",
    icon: "https://www.cloudflare.com/favicon.ico",
    appName: "Cloudflare",
    connectionUrl: "https://mcp.cloudflare.com/sse",
    connectionToken: null,
    metadata: { provider: "cloudflare", requiresApiKey: true, official: true },
  },

  aws: {
    title: "AWS",
    description: "Amazon Web Services cloud infrastructure management",
    icon: "https://assets.decocache.com/mcp/ece686cd-c380-41e8-97c8-34616a3bf5ba/AWS.svg",
    appName: "deco/aws",
    connectionUrl: "https://api.decocms.com/apps/deco/aws/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  // AI & LLM
  openrouter: {
    title: "OpenRouter",
    description:
      "Access 100+ LLM models from a single API with unified pricing",
    icon: "https://assets.decocache.com/decocms/b2e2f64f-6025-45f7-9e8c-3b3ebdd073d8/openrouter_logojpg.jpg",
    appName: "deco/openrouter",
    connectionUrl: "https://sites-openrouter.decocache.com/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  perplexity: {
    title: "Perplexity",
    description: "AI-powered search and research assistant",
    icon: "https://assets.decocache.com/mcp/1b3b7880-e7a5-413b-8db2-601e84b22bcd/Perplexity.svg",
    appName: "deco/mcp-perplexity",
    connectionUrl: "https://api.decocms.com/apps/deco/mcp-perplexity/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  elevenlabs: {
    title: "ElevenLabs",
    description: "AI voice generation and text-to-speech",
    icon: "https://assets.decocache.com/mcp/d5b8b14e-7611-4cdd-8453-cad6a4c23703/ElevenLabs.svg",
    appName: "deco/elevenlabs",
    connectionUrl: "https://api.decocms.com/apps/deco/elevenlabs/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  // Google Workspace
  gmail: {
    title: "Gmail",
    description: "Send, read, and manage emails in Gmail",
    icon: "https://assets.decocache.com/mcp/b4dbd04f-2d03-4e29-a881-f924f5946c4e/Gmail.svg",
    appName: "deco/google-gmail",
    connectionUrl: "https://api.decocms.com/apps/deco/google-gmail/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  googleCalendar: {
    title: "Google Calendar",
    description:
      "Integrate and manage your Google Calendar. Create, edit and delete events, check availability and sync your calendars.",
    icon: "https://assets.decocache.com/mcp/b5fffe71-647a-461c-aa39-3da07b86cc96/Google-Meets.svg",
    appName: "deco/google-calendar",
    connectionUrl: "https://sites-google-calendar.decocache.com/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  googleSheets: {
    title: "Google Sheets",
    description: "Create and edit spreadsheets, manage data",
    icon: "https://assets.decocache.com/mcp/0b05c082-ce9d-4879-9258-1acbecf9bf68/Google-Sheets.svg",
    appName: "deco/google-sheets",
    connectionUrl: "https://api.decocms.com/apps/deco/google-sheets/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  googleDocs: {
    title: "Google Docs",
    description: "Read, write, and edit content in Google Docs.",
    icon: "https://assets.decocache.com/mcp/e0a00fae-ba76-487a-9f62-7b21bbb08d50/Google-Docs.svg",
    appName: "deco/google-docs",
    connectionUrl: "https://api.decocms.com/apps/deco/google-docs/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  googleDrive: {
    title: "Google Drive",
    description: "Store, share, and manage files in the cloud",
    icon: "https://assets.decocache.com/mcp/bc609f7d-e7c7-433d-b432-93639c5c84bf/Google-Drive.svg",
    appName: "deco/google-drive",
    connectionUrl: "https://api.decocms.com/apps/deco/google-drive/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  googleTagManager: {
    title: "Google Tag Manager",
    description: "Manage marketing tags and tracking pixels",
    icon: "https://img.icons8.com/color/1200/google-tag-manager.jpg",
    appName: "deco/google-tag-manager",
    connectionUrl: "https://sites-google-tag-manager.decocache.com/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  youtube: {
    title: "YouTube",
    description: "Manage YouTube videos and channels",
    icon: "https://assets.decocache.com/mcp/cac50532-150e-437d-a996-91fd9a0c115e/YouTube.svg",
    appName: "deco/google-youtube",
    connectionUrl: "https://api.decocms.com/apps/deco/google-youtube/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  // Communication
  discord: {
    title: "Discord Bot",
    description:
      "Discord Bot integration for sending messages, managing channels, and server moderation",
    icon: "https://support.discord.com/hc/user_images/PRywUXcqg0v5DD6s7C3LyQ.jpeg",
    appName: "deco/discordbot",
    connectionUrl: "https://api.decocms.com/apps/deco/discordbot/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  discordWebhook: {
    title: "Discord Webhook",
    description: "Send rich, formatted messages to Discord channels.",
    icon: "https://assets.decocache.com/mcp/a626d828-e641-4931-8557-850276e91702/DiscordWebhook.svg",
    appName: "deco/discohook",
    connectionUrl: "https://api.decocms.com/apps/deco/discohook/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  slack: {
    title: "Slack",
    description: "Send messages and manage Slack workspaces",
    icon: "https://assets.decocache.com/mcp/f7e005a9-1c53-48f7-989b-955baa422be1/Slack.svg",
    appName: "deco/slack",
    connectionUrl: "https://api.decocms.com/apps/deco/slack/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  resend: {
    title: "Resend",
    description: "Send transactional emails with modern API",
    icon: "https://assets.decocache.com/mcp/932e4c3a-6045-40af-9fd1-42894bdd138e/Resend.svg",
    appName: "deco/resend",
    connectionUrl: "https://api.decocms.com/apps/deco/resend/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  // Productivity & Documentation
  notion: {
    title: "Notion",
    description: "Manage pages and databases in Notion workspaces",
    icon: "https://www.notion.so/images/logo-ios.png",
    appName: "Notion",
    connectionUrl: "https://mcp.notion.com/mcp",
    connectionToken: null,
    metadata: { provider: "notion", requiresOAuth: true, official: true },
  },

  grain: {
    title: "Grain",
    description: "Meeting recording, transcription, and compliance archival",
    icon: "https://assets.decocache.com/mcp/1bfc7176-e7be-487c-83e6-4b9e970a8e10/Grain.svg",
    appName: "grain/grain-mcp",
    connectionUrl: "https://api.grain.com/_/mcp",
    connectionToken: null,
    metadata: { provider: "grain", official: true },
  },

  airtable: {
    title: "Airtable",
    description: "Manage databases, records, and collaborative workflows",
    icon: "https://assets.decocache.com/mcp/e724f447-3b98-46c4-9194-6b79841305a2/Airtable.svg",
    appName: "deco/airtable",
    connectionUrl: "https://api.decocms.com/apps/deco/airtable/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  jira: {
    title: "Jira",
    description: "Project management and issue tracking",
    icon: "https://assets.decocache.com/mcp/7bae17a9-cfdb-4969-99ca-436b7a4dcf40/Jira.svg",
    appName: "deco/jira",
    connectionUrl: "https://api.decocms.com/apps/deco/jira/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  hubspot: {
    title: "HubSpot",
    description: "CRM, marketing, and sales automation",
    icon: "https://www.hubspot.com/hubfs/HubSpot_Logos/HubSpot-Inversed-Favicon.png",
    appName: "deco/hubspot",
    connectionUrl: "https://api.decocms.com/apps/deco/hubspot/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  // Automation & Scraping
  apify: {
    title: "Apify",
    description: "Web scraping and automation for data collection",
    icon: "https://assets.decocache.com/mcp/4eda8c60-503f-4001-9edb-89de961ab7f0/Apify.svg",
    appName: "deco/apify",
    connectionUrl: "https://api.decocms.com/apps/deco/apify/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  browserUse: {
    title: "Browser Use",
    description: "Browser automation for testing and scraping",
    icon: "https://assets.decocache.com/mcp/1a7a2573-023c-43ed-82a2-95d77adca3db/Browser-Use.svg",
    appName: "deco/browser-use",
    connectionUrl: "https://api.decocms.com/apps/deco/browser-use/mcp",
    connectionToken: null,
    metadata: { provider: "deco", decoHosted: true },
  },

  // Payments
  stripe: {
    title: "Stripe",
    description: "Payment processing and subscription management",
    icon: "https://stripe.com/favicon.ico",
    appName: "Stripe",
    connectionUrl: "https://mcp.stripe.com/",
    connectionToken: null,
    metadata: { provider: "stripe", requiresOAuth: true, official: true },
  },

  // Brazilian APIs
  brasilApi: {
    title: "Brasil API",
    description: "CEP, CNPJ, banks, holidays, and Brazilian public data",
    icon: "https://assets.decocache.com/mcp/bd684c47-0525-4659-a298-97fa60ba24f1/BrasilAPI.svg",
    appName: "deco/brasilapi",
    connectionUrl: "https://api.decocms.com/apps/deco/brasilapi/mcp",
    connectionToken: null,
    metadata: { provider: "deco", decoHosted: true },
  },

  queridoDiario: {
    title: "Querido Diário",
    description: "Access Brazilian official gazettes data",
    icon: "https://assets.decocache.com/mcp/0bb451a6-db7c-4f9a-9720-8f87b8898da5/QueridoDirio.svg",
    appName: "deco/querido-diario",
    connectionUrl: "https://api.decocms.com/apps/deco/querido-diario/mcp",
    connectionToken: null,
    metadata: { provider: "deco", decoHosted: true },
  },

  datajud: {
    title: "Datajud",
    description: "Brazilian judicial data from CNJ",
    icon: "https://www.cnj.jus.br/wp-content/uploads/2023/09/logo-cnj-portal-20-09-1.svg",
    appName: "deco/datajud",
    connectionUrl: "https://api.decocms.com/apps/deco/datajud/mcp",
    connectionToken: null,
    metadata: { provider: "deco", decoHosted: true },
  },

  // Design & Media
  figma: {
    title: "Figma",
    description: "Design collaboration and prototyping",
    icon: "https://assets.decocache.com/mcp/eb714f8a-404b-4b8e-bfc4-f3ce5bde6f51/Figma.svg",
    appName: "deco/figma",
    connectionUrl: "https://api.decocms.com/apps/deco/figma/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresOAuth: true, decoHosted: true },
  },

  // E-commerce
  shopify: {
    title: "Shopify",
    description: "E-commerce platform management",
    icon: "https://assets.decocache.com/mcp/37122d09-6ceb-4d25-a641-11ce4af8a19b/Shopify.svg",
    appName: "deco/shopify-mcp",
    connectionUrl: "https://api.decocms.com/apps/deco/shopify-mcp/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  vtex: {
    title: "VTEX",
    description: "E-commerce platform for Latin America",
    icon: "https://assets.decocache.com/mcp/0d6e795b-cefd-4853-9a51-93b346c52c3f/VTEX.svg",
    appName: "deco-team/mcp-vtex",
    connectionUrl: "https://api.decocms.com/apps/deco-team/mcp-vtex/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },

  // Logistics
  superfrete: {
    title: "SuperFrete",
    description: "Brazilian shipping and logistics",
    icon: "https://assets.decocache.com/mcp/2fdb628e-c10c-4fac-8985-b55e383a64b2/SuperFrete.svg",
    appName: "deco/superfrete",
    connectionUrl: "https://api.decocms.com/apps/deco/superfrete/mcp",
    connectionToken: null,
    metadata: { provider: "deco", requiresApiKey: true, decoHosted: true },
  },
} as const satisfies Record<string, Connection>;

export type ConnectionKey = keyof typeof CONNECTIONS;

// =============================================================================
// Gateway Templates
// =============================================================================

export const GATEWAYS = {
  // Default Hub - matches production behavior (exclusion mode = includes all connections)
  defaultHub: {
    title: "Default Hub",
    description: "Auto-created Hub for organization",
    toolSelectionStrategy: "passthrough",
    toolSelectionMode: "exclusion",
    icon: null,
    isDefault: true,
    connections: [], // Empty with exclusion mode = include all
  },

  simpleDefault: {
    title: "My First Gateway",
    description: "Default gateway for getting started with MCP tools",
    toolSelectionStrategy: "passthrough",
    toolSelectionMode: "inclusion",
    icon: null,
    isDefault: false,
    connections: ["github", "openrouter", "notion"],
  },

  llm: {
    title: "LLM Gateway",
    description:
      "AI model access with cost tracking (OpenRouter + GitHub Copilot)",
    toolSelectionStrategy: "passthrough",
    toolSelectionMode: "inclusion",
    icon: "https://assets.decocache.com/decocms/b2e2f64f-6025-45f7-9e8c-3b3ebdd073d8/openrouter_logojpg.jpg",
    isDefault: false,
    connections: ["openrouter", "github", "perplexity", "elevenlabs"],
  },

  devGateway: {
    title: "Development & Deployments",
    description: "Complete development workflow: code, deployments, database",
    toolSelectionStrategy: "passthrough",
    toolSelectionMode: "inclusion",
    icon: "https://assets.decocache.com/mcp/02e06fe6-a820-4c42-b960-bce022362702/GitHub.svg",
    isDefault: false,
    connections: ["github", "vercel", "supabase", "aws", "cloudflare"],
  },

  compliance: {
    title: "Knowledge & Compliance",
    description: "Documentation, meeting records, and audit trails",
    toolSelectionStrategy: "passthrough",
    toolSelectionMode: "inclusion",
    icon: "https://assets.decocache.com/mcp/1bfc7176-e7be-487c-83e6-4b9e970a8e10/Grain.svg",
    isDefault: false,
    connections: ["notion", "grain", "airtable", "jira"],
  },

  dataGateway: {
    title: "Data & Automation",
    description: "Web scraping, data collection, and automation",
    toolSelectionStrategy: "passthrough",
    toolSelectionMode: "inclusion",
    icon: "https://assets.decocache.com/mcp/4eda8c60-503f-4001-9edb-89de961ab7f0/Apify.svg",
    isDefault: false,
    connections: ["apify", "browserUse", "brasilApi"],
  },

  allAccess: {
    title: "All Access Gateway",
    description: "Full access to all connected tools (restricted to admins)",
    toolSelectionStrategy: "passthrough",
    toolSelectionMode: "inclusion",
    icon: null,
    isDefault: false,
    connections: [
      "github",
      "openrouter",
      "perplexity",
      "notion",
      "grain",
      "stripe",
      "vercel",
      "supabase",
      "apify",
      "gmail",
      "googleCalendar",
      "googleSheets",
      "googleDocs",
      "googleDrive",
      "googleTagManager",
      "discord",
      "slack",
      "airtable",
      "brasilApi",
      "cloudflare",
      "jira",
      "hubspot",
      "figma",
      "shopify",
    ],
  },
} as const satisfies Record<string, Gateway>;

export type GatewayKey = keyof typeof GATEWAYS;

// =============================================================================
// Picker Helpers
// =============================================================================

/**
 * Get all well-known connections (Mesh MCP, MCP Registry, Deco Store)
 * These are installed by default in production environments.
 */
export function getWellKnownConnections(): Record<
  WellKnownConnectionKey,
  Connection
> {
  return { ...WELL_KNOWN_CONNECTIONS };
}

export function pickConnections<K extends ConnectionKey>(
  keys: K[],
): Record<K, Connection> {
  const result = {} as Record<K, Connection>;
  for (const key of keys) {
    const conn = CONNECTIONS[key];
    if (conn) result[key] = conn;
  }
  return result;
}

export function pickGateways<K extends GatewayKey>(
  keys: K[],
): Record<K, Gateway> {
  const result = {} as Record<K, Gateway>;
  for (const key of keys) {
    const gw = GATEWAYS[key];
    if (gw) result[key] = gw;
  }
  return result;
}
