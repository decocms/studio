/**
 * Onboarding Organization
 *
 * Clean slate organization for onboarding - shows early usage:
 * - 1 user (owner)
 * - 3 well-known connections (Mesh MCP, MCP Registry, Deco Store)
 * - 1 default gateway
 * - ~300 monitoring logs over 3 days (light usage pattern)
 */

import type { Kysely } from "kysely";
import type { Database } from "../../../../src/storage/types";
import type {
  OrgConfig,
  OrgSeedResult,
  OrgUser,
  MonitoringLog,
} from "../seeder";
import { createOrg, TIME, USER_AGENTS } from "../seeder";
import { getWellKnownConnections } from "../catalog";

// =============================================================================
// Configuration
// =============================================================================

const EMAIL_DOMAIN = "@onboarding.local";

// Single owner user - matches production organization creation
const USERS: Record<string, OrgUser> = {
  admin: {
    role: "admin",
    memberRole: "owner",
    name: "Alice Admin",
    email: `admin${EMAIL_DOMAIN}`,
  },
};

// Only well-known connections - matches production seedOrgDb behavior
const CONNECTIONS = {
  ...getWellKnownConnections(),
};

// Default Hub with only well-known connections - matches production
const GATEWAYS = {
  defaultHub: {
    title: "Default Hub",
    description: "Auto-created Hub for organization",
    toolSelectionStrategy: "passthrough" as const,
    toolSelectionMode: "inclusion" as const,
    icon: null,
    isDefault: true,
    connections: ["meshMcp", "mcpRegistry", "decoStore"],
  },
};

// =============================================================================
// Static Logs - Hand-crafted onboarding journey over 3 days
// =============================================================================

const STATIC_LOGS: MonitoringLog[] = [
  // 3 days ago: First connection exploration
  {
    connectionKey: "mcpRegistry",
    toolName: "search_servers",
    input: { query: "github" },
    output: { results: [], total: 45 },
    isError: false,
    durationMs: 234,
    offsetMs: -3 * TIME.DAY,
    userKey: "admin",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "defaultHub",
  },
  {
    connectionKey: "decoStore",
    toolName: "list_verified_mcps",
    input: {},
    output: { mcps: [], total: 127 },
    isError: false,
    durationMs: 189,
    offsetMs: -3 * TIME.DAY,
    userKey: "admin",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "defaultHub",
  },

  // 2 days ago: Exploring Mesh capabilities
  {
    connectionKey: "meshMcp",
    toolName: "list_connections",
    input: {},
    output: { connections: [] },
    isError: false,
    durationMs: 145,
    offsetMs: -2 * TIME.DAY,
    userKey: "admin",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "defaultHub",
  },
  {
    connectionKey: "meshMcp",
    toolName: "list_gateways",
    input: {},
    output: { gateways: [] },
    isError: false,
    durationMs: 123,
    offsetMs: -2 * TIME.DAY,
    userKey: "admin",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "defaultHub",
  },
  {
    connectionKey: "mcpRegistry",
    toolName: "get_server_details",
    input: { server: "github" },
    output: { name: "GitHub MCP", version: "1.0.0" },
    isError: false,
    durationMs: 267,
    offsetMs: -2 * TIME.DAY,
    userKey: "admin",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "defaultHub",
  },

  // Yesterday: Active exploration
  {
    connectionKey: "decoStore",
    toolName: "search_mcps",
    input: { query: "notion" },
    output: { results: [], total: 12 },
    isError: false,
    durationMs: 198,
    offsetMs: -1 * TIME.DAY,
    userKey: "admin",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "defaultHub",
  },
  {
    connectionKey: "meshMcp",
    toolName: "get_organization_info",
    input: {},
    output: { name: "Onboarding", members: 1 },
    isError: false,
    durationMs: 112,
    offsetMs: -1 * TIME.DAY,
    userKey: "admin",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "defaultHub",
  },

  // Today: Getting started
  {
    connectionKey: "mcpRegistry",
    toolName: "list_categories",
    input: {},
    output: { categories: [] },
    isError: false,
    durationMs: 156,
    offsetMs: -3 * TIME.HOUR,
    userKey: "admin",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "defaultHub",
  },
];

// =============================================================================
// Synthetic Log Generator for Onboarding
// =============================================================================

interface ToolTemplate {
  toolName: string;
  connectionKey: string;
  weight: number;
  avgDurationMs: number;
  durationVariance: number;
  sampleInputs: object[];
  sampleOutputs: object[];
}

// Simple tools for onboarding exploration
const TOOL_TEMPLATES: ToolTemplate[] = [
  // Mesh MCP (40%)
  {
    toolName: "list_connections",
    connectionKey: "meshMcp",
    weight: 0.15,
    avgDurationMs: 145,
    durationVariance: 50,
    sampleInputs: [{}],
    sampleOutputs: [{ connections: [] }],
  },
  {
    toolName: "list_gateways",
    connectionKey: "meshMcp",
    weight: 0.12,
    avgDurationMs: 123,
    durationVariance: 40,
    sampleInputs: [{}],
    sampleOutputs: [{ gateways: [] }],
  },
  {
    toolName: "get_organization_info",
    connectionKey: "meshMcp",
    weight: 0.08,
    avgDurationMs: 112,
    durationVariance: 35,
    sampleInputs: [{}],
    sampleOutputs: [{ name: "Onboarding", members: 1 }],
  },
  {
    toolName: "get_monitoring_stats",
    connectionKey: "meshMcp",
    weight: 0.05,
    avgDurationMs: 167,
    durationVariance: 55,
    sampleInputs: [{}],
    sampleOutputs: [{ total_calls: 234 }],
  },

  // MCP Registry (35%)
  {
    toolName: "search_servers",
    connectionKey: "mcpRegistry",
    weight: 0.15,
    avgDurationMs: 234,
    durationVariance: 80,
    sampleInputs: [
      { query: "github" },
      { query: "notion" },
      { query: "slack" },
    ],
    sampleOutputs: [{ results: [], total: 45 }],
  },
  {
    toolName: "get_server_details",
    connectionKey: "mcpRegistry",
    weight: 0.1,
    avgDurationMs: 267,
    durationVariance: 90,
    sampleInputs: [{ server: "github" }, { server: "notion" }],
    sampleOutputs: [{ name: "GitHub MCP", version: "1.0.0" }],
  },
  {
    toolName: "list_categories",
    connectionKey: "mcpRegistry",
    weight: 0.1,
    avgDurationMs: 156,
    durationVariance: 50,
    sampleInputs: [{}],
    sampleOutputs: [{ categories: [] }],
  },

  // Deco Store (25%)
  {
    toolName: "list_verified_mcps",
    connectionKey: "decoStore",
    weight: 0.12,
    avgDurationMs: 189,
    durationVariance: 60,
    sampleInputs: [{}],
    sampleOutputs: [{ mcps: [], total: 127 }],
  },
  {
    toolName: "search_mcps",
    connectionKey: "decoStore",
    weight: 0.08,
    avgDurationMs: 198,
    durationVariance: 65,
    sampleInputs: [
      { query: "github" },
      { query: "notion" },
      { query: "slack" },
    ],
    sampleOutputs: [{ results: [], total: 12 }],
  },
  {
    toolName: "get_mcp_details",
    connectionKey: "decoStore",
    weight: 0.05,
    avgDurationMs: 212,
    durationVariance: 70,
    sampleInputs: [{ id: "github-mcp" }],
    sampleOutputs: [{ name: "GitHub MCP", verified: true }],
  },
];

function weightedRandom<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

function generateOnboardingLogs(targetCount: number): MonitoringLog[] {
  const logs: MonitoringLog[] = [];
  const totalDays = 3;

  // Pre-calculate logs per day - progressive increase (learning curve)
  const logsPerDay = [
    Math.floor(targetCount * 0.25), // Day 3: 25% (just starting)
    Math.floor(targetCount * 0.35), // Day 2: 35% (exploring more)
    Math.floor(targetCount * 0.4), // Day 1: 40% (getting comfortable)
  ];

  // Generate logs for each day
  for (let day = 0; day < totalDays; day++) {
    const logsForThisDay = logsPerDay[day] || 0;

    for (let logIdx = 0; logIdx < logsForThisDay; logIdx++) {
      const template = weightedRandom(TOOL_TEMPLATES);
      const isError = Math.random() < 0.03; // Very few errors for onboarding

      // Distributed hourly pattern - more activity during business hours
      let hourOffset: number;
      const hourPattern = Math.random();

      if (hourPattern < 0.3) {
        // 30% - Morning (9am-12pm)
        hourOffset = 9 + Math.random() * 3;
      } else if (hourPattern < 0.6) {
        // 30% - Afternoon (2pm-5pm)
        hourOffset = 14 + Math.random() * 3;
      } else if (hourPattern < 0.8) {
        // 20% - Late afternoon (5pm-7pm)
        hourOffset = 17 + Math.random() * 2;
      } else if (hourPattern < 0.9) {
        // 10% - Evening (7pm-10pm)
        hourOffset = 19 + Math.random() * 3;
      } else {
        // 10% - Off hours
        hourOffset = Math.random() * 24;
      }

      const minuteOffset = Math.random() * 60;
      const secondOffset = Math.random() * 60;

      const randomOffset =
        day * TIME.DAY +
        hourOffset * TIME.HOUR +
        minuteOffset * TIME.MINUTE +
        secondOffset * 1000;

      const totalOffsetMs = -randomOffset;

      const duration =
        template.avgDurationMs +
        (Math.random() - 0.5) * 2 * template.durationVariance;
      const input = template.sampleInputs[
        Math.floor(Math.random() * template.sampleInputs.length)
      ] as Record<string, unknown>;
      const output = (
        isError
          ? { error: "Request failed" }
          : template.sampleOutputs[
              Math.floor(Math.random() * template.sampleOutputs.length)
            ]
      ) as Record<string, unknown>;

      logs.push({
        connectionKey: template.connectionKey,
        toolName: template.toolName,
        input,
        output,
        isError,
        durationMs: Math.max(50, Math.round(duration)),
        offsetMs: totalOffsetMs,
        userKey: "admin",
        userAgent: USER_AGENTS.meshClient,
        gatewayKey: "defaultHub",
      });
    }
  }

  return logs.sort((a, b) => a.offsetMs - b.offsetMs);
}

// =============================================================================
// Seed Function
// =============================================================================

export const ONBOARDING_SLUG = "onboarding";

export async function seedOnboarding(
  db: Kysely<Database>,
): Promise<OrgSeedResult> {
  // Generate ~300 synthetic logs + static story logs
  // This simulates 3 days of light onboarding usage (~100/day average)
  const syntheticLogs = generateOnboardingLogs(300);
  const allLogs = [...STATIC_LOGS, ...syntheticLogs];

  const config: OrgConfig = {
    orgName: "Onboarding",
    orgSlug: ONBOARDING_SLUG,
    users: USERS,
    apiKeys: [{ userKey: "admin", name: "Onboarding Admin Key" }],
    connections: CONNECTIONS,
    gateways: GATEWAYS,
    gatewayConnections: [
      // Default Hub with well-known connections (production behavior)
      { gatewayKey: "defaultHub", connectionKey: "meshMcp" },
      { gatewayKey: "defaultHub", connectionKey: "mcpRegistry" },
      { gatewayKey: "defaultHub", connectionKey: "decoStore" },
    ],
    logs: allLogs,
    ownerUserKey: "admin",
  };

  return createOrg(db, config);
}
