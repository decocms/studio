/**
 * Deco Bank Organization
 *
 * Large corporate banking environment simulating 30 days of high-volume usage:
 * - 12 users across multiple departments
 * - 24 connections (3 well-known + verified MCPs from Deco Store)
 * - 6 gateways (Default Hub + 5 specialized)
 * - ~1M synthetic + static monitoring logs with realistic activity patterns:
 *   - Peak hours: 9-11am (morning) and 2-4pm (afternoon)
 *   - Weekends with 80% reduced activity (visible valleys)
 *   - Special spike days on deployments (days 2, 7, 14, 21, 28)
 *   - Night/lunch hours with minimal activity (realistic lows)
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
import {
  getWellKnownConnections,
  pickConnections,
  pickGateways,
} from "../catalog";

// =============================================================================
// Configuration
// =============================================================================

const EMAIL_DOMAIN = "@decobank.com";

const USERS: Record<string, OrgUser> = {
  cto: {
    role: "admin",
    memberRole: "owner",
    name: "Carlos Mendes",
    email: `carlos.mendes${EMAIL_DOMAIN}`,
  },
  techLead: {
    role: "admin",
    memberRole: "admin",
    name: "Ana Silva",
    email: `ana.silva${EMAIL_DOMAIN}`,
  },
  seniorDev1: {
    role: "user",
    memberRole: "user",
    name: "Pedro Costa",
    email: `pedro.costa${EMAIL_DOMAIN}`,
  },
  seniorDev2: {
    role: "user",
    memberRole: "user",
    name: "Mariana Santos",
    email: `mariana.santos${EMAIL_DOMAIN}`,
  },
  midDev1: {
    role: "user",
    memberRole: "user",
    name: "Rafael Oliveira",
    email: `rafael.oliveira${EMAIL_DOMAIN}`,
  },
  junior: {
    role: "user",
    memberRole: "user",
    name: "Gabriel Lima",
    email: `gabriel.lima${EMAIL_DOMAIN}`,
  },
  analyst: {
    role: "user",
    memberRole: "user",
    name: "Lucas Fernandes",
    email: `lucas.fernandes${EMAIL_DOMAIN}`,
  },
  dataEngineer: {
    role: "user",
    memberRole: "user",
    name: "Beatriz Rodrigues",
    email: `beatriz.rodrigues${EMAIL_DOMAIN}`,
  },
  security: {
    role: "admin",
    memberRole: "admin",
    name: "Roberto Alves",
    email: `roberto.alves${EMAIL_DOMAIN}`,
  },
  compliance: {
    role: "user",
    memberRole: "user",
    name: "Julia Ferreira",
    email: `julia.ferreira${EMAIL_DOMAIN}`,
  },
  productManager: {
    role: "user",
    memberRole: "user",
    name: "Fernanda Souza",
    email: `fernanda.souza${EMAIL_DOMAIN}`,
  },
  qa: {
    role: "user",
    memberRole: "user",
    name: "Ricardo Martins",
    email: `ricardo.martins${EMAIL_DOMAIN}`,
  },
};

const USER_ACTIVITY_WEIGHTS: Record<string, number> = {
  techLead: 0.18,
  seniorDev1: 0.15,
  seniorDev2: 0.14,
  midDev1: 0.12,
  analyst: 0.11,
  dataEngineer: 0.1,
  junior: 0.08,
  security: 0.06,
  productManager: 0.04,
  qa: 0.01,
  cto: 0.01,
  compliance: 0.0,
};

// Include well-known connections (Mesh MCP, MCP Registry, Deco Store) + business connections
const CONNECTIONS = {
  ...getWellKnownConnections(),
  ...pickConnections([
    "openrouter",
    "github",
    "cloudflare",
    "aws",
    "gmail",
    "googleCalendar",
    "googleDocs",
    "googleDrive",
    "googleSheets",
    "googleTagManager",
    "jira",
    "brasilApi",
    "apify",
    "airtable",
    "slack",
    "discord",
    "discordWebhook",
    "figma",
    "grain",
    "notion",
    "perplexity",
  ]),
};

// Default Hub (production-like) + specialized gateways
const GATEWAYS = {
  ...pickGateways([
    "llm",
    "devGateway",
    "compliance",
    "dataGateway",
    "allAccess",
  ]),
  // Override defaultHub to include only well-known connections (production behavior)
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
// Static Logs - Hand-crafted story moments over 30 days
// =============================================================================

const STATIC_LOGS: MonitoringLog[] = [
  // 30 days ago: Monthly planning
  {
    connectionKey: "notion",
    toolName: "create_page",
    input: { parent_id: "workspace_root", title: "Monthly OKRs" },
    output: { page_id: "page_monthly_okrs" },
    isError: false,
    durationMs: 345,
    offsetMs: -30 * TIME.DAY,
    userKey: "cto",
    userAgent: USER_AGENTS.notionDesktop,
    gatewayKey: "compliance",
  },
  {
    connectionKey: "grain",
    toolName: "get_transcript",
    input: { meeting_id: "meet_monthly_review" },
    output: { transcript: "Monthly Review...", duration_minutes: 120 },
    isError: false,
    durationMs: 1847,
    offsetMs: -30 * TIME.DAY,
    userKey: "cto",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "compliance",
  },

  // 28 days ago: Security PR
  {
    connectionKey: "github",
    toolName: "create_pull_request",
    input: { repo: "payment-gateway", title: "SECURITY: SQL injection patch" },
    output: { number: 1892, state: "open" },
    isError: false,
    durationMs: 456,
    offsetMs: -28 * TIME.DAY,
    userKey: "security",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "devGateway",
  },

  // 25 days ago: Infrastructure check
  {
    connectionKey: "cloudflare",
    toolName: "list_zones",
    input: {},
    output: { zones: [{ name: "decobank.com", status: "active" }] },
    isError: false,
    durationMs: 234,
    offsetMs: -25 * TIME.DAY,
    userKey: "techLead",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "devGateway",
  },

  // 23 days ago: AWS resources check
  {
    connectionKey: "aws",
    toolName: "list_s3_buckets",
    input: {},
    output: { buckets: [{ name: "decobank-prod-assets" }] },
    isError: false,
    durationMs: 345,
    offsetMs: -23 * TIME.DAY,
    userKey: "seniorDev1",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "devGateway",
  },

  // 22 days ago: AI code review
  {
    connectionKey: "openrouter",
    toolName: "chat_completion",
    input: {
      model: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "user", content: "Review this code..." }],
    },
    output: { response: "Security concerns found...", tokens_used: 1847 },
    isError: false,
    durationMs: 3456,
    offsetMs: -22 * TIME.DAY,
    userKey: "seniorDev2",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "llm",
    properties: { cost_usd: "0.047" },
  },

  // 20 days ago: Brasil API integration
  {
    connectionKey: "brasilApi",
    toolName: "get_bank_info",
    input: { code: "341" },
    output: { name: "Itaú", fullName: "Itaú Unibanco" },
    isError: false,
    durationMs: 456,
    offsetMs: -20 * TIME.DAY,
    userKey: "analyst",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "dataGateway",
  },

  // 18 days ago: Postmortem
  {
    connectionKey: "notion",
    toolName: "create_page",
    input: { title: "Postmortem: Payment Gateway Timeout" },
    output: { page_id: "page_postmortem" },
    isError: false,
    durationMs: 432,
    offsetMs: -18 * TIME.DAY,
    userKey: "techLead",
    userAgent: USER_AGENTS.notionDesktop,
    gatewayKey: "compliance",
  },

  // 16 days ago: Gmail automation
  {
    connectionKey: "gmail",
    toolName: "send_email",
    input: { to: "support@decobank.com", subject: "Weekly Report" },
    output: { id: "msg_123", threadId: "thread_456" },
    isError: false,
    durationMs: 567,
    offsetMs: -16 * TIME.DAY,
    userKey: "analyst",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "allAccess",
  },

  // 14 days ago: LLM cost analysis
  {
    connectionKey: "openrouter",
    toolName: "get_usage_stats",
    input: { period: "last_30_days" },
    output: { total_requests: 45678, total_cost: 1234.56 },
    isError: false,
    durationMs: 234,
    offsetMs: -14 * TIME.DAY,
    userKey: "cto",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "llm",
  },

  // 12 days ago: Bug investigation
  {
    connectionKey: "github",
    toolName: "search_code",
    input: { query: "processRefund", org: "decobank" },
    output: {
      total_count: 8,
      items: [{ path: "src/services/refund-processor.ts" }],
    },
    isError: false,
    durationMs: 567,
    offsetMs: -12 * TIME.DAY,
    userKey: "seniorDev2",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "devGateway",
  },

  // 10 days ago: Compliance audit
  {
    connectionKey: "grain",
    toolName: "get_transcript",
    input: { meeting_id: "meet_compliance_audit" },
    output: { transcript: "BACEN Compliance Audit...", duration_minutes: 87 },
    isError: false,
    durationMs: 2134,
    offsetMs: -10 * TIME.DAY,
    userKey: "compliance",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "compliance",
  },

  // 8 days ago: Slack notification
  {
    connectionKey: "slack",
    toolName: "post_message",
    input: { channel: "#engineering", text: "Deployment complete" },
    output: { ok: true, ts: "1234567890.123456" },
    isError: false,
    durationMs: 234,
    offsetMs: -8 * TIME.DAY,
    userKey: "qa",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "allAccess",
  },

  // 5 days ago: AI code generation
  {
    connectionKey: "openrouter",
    toolName: "chat_completion",
    input: {
      model: "openai/gpt-4-turbo",
      messages: [{ role: "user", content: "Generate TypeScript types..." }],
    },
    output: { response: "Here are the types...", tokens_used: 687 },
    isError: false,
    durationMs: 2345,
    offsetMs: -5 * TIME.DAY,
    userKey: "junior",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "llm",
  },

  // 3 days ago: Repository maintenance
  {
    connectionKey: "github",
    toolName: "list_repositories",
    input: { org: "decobank", type: "private" },
    output: { repositories: [{ name: "payment-gateway" }], total: 523 },
    isError: false,
    durationMs: 223,
    offsetMs: -2 * TIME.DAY,
    userKey: "techLead",
    userAgent: USER_AGENTS.meshClient,
    gatewayKey: "devGateway",
  },

  // Today: Daily standup
  {
    connectionKey: "notion",
    toolName: "create_page",
    input: { parent_id: "db_standups", title: "Daily Standup" },
    output: { page_id: "page_standup_today" },
    isError: false,
    durationMs: 267,
    offsetMs: -2 * TIME.HOUR,
    userKey: "techLead",
    userAgent: USER_AGENTS.notionDesktop,
    gatewayKey: "compliance",
  },
];

// =============================================================================
// Synthetic Log Generator
// =============================================================================

interface ToolTemplate {
  toolName: string;
  connectionKey: string;
  weight: number;
  avgDurationMs: number;
  durationVariance: number;
  sampleInputs: object[];
  sampleOutputs: object[];
  properties?: Record<string, string>;
}

const TOOL_TEMPLATES: ToolTemplate[] = [
  // GitHub (25%)
  {
    toolName: "list_repositories",
    connectionKey: "github",
    weight: 0.08,
    avgDurationMs: 210,
    durationVariance: 90,
    sampleInputs: [{ org: "decobank" }],
    sampleOutputs: [{ repositories: [], total: 523 }],
  },
  {
    toolName: "create_pull_request",
    connectionKey: "github",
    weight: 0.05,
    avgDurationMs: 340,
    durationVariance: 120,
    sampleInputs: [{ repo: "payment-gateway", title: "Feature" }],
    sampleOutputs: [{ number: 1234, state: "open" }],
  },
  {
    toolName: "get_pr_status",
    connectionKey: "github",
    weight: 0.06,
    avgDurationMs: 180,
    durationVariance: 70,
    sampleInputs: [{ repo: "payment-gateway", pr_number: 1234 }],
    sampleOutputs: [{ state: "open", checks: { passed: 7 } }],
  },
  {
    toolName: "search_code",
    connectionKey: "github",
    weight: 0.03,
    avgDurationMs: 420,
    durationVariance: 180,
    sampleInputs: [{ query: "processPayment" }],
    sampleOutputs: [{ items: [], total: 127 }],
  },

  // OpenRouter (22%)
  {
    toolName: "chat_completion",
    connectionKey: "openrouter",
    weight: 0.15,
    avgDurationMs: 1850,
    durationVariance: 1200,
    sampleInputs: [{ model: "anthropic/claude-3.5-sonnet" }],
    sampleOutputs: [{ response: "...", tokens_used: 856 }],
    properties: { cost_usd: "0.018" },
  },
  {
    toolName: "list_models",
    connectionKey: "openrouter",
    weight: 0.04,
    avgDurationMs: 180,
    durationVariance: 60,
    sampleInputs: [{}],
    sampleOutputs: [{ models: [], total: 127 }],
  },
  {
    toolName: "get_usage_stats",
    connectionKey: "openrouter",
    weight: 0.03,
    avgDurationMs: 220,
    durationVariance: 80,
    sampleInputs: [{ period: "last_7_days" }],
    sampleOutputs: [{ total_requests: 12847, total_cost: 2456.78 }],
  },

  // Notion (18%)
  {
    toolName: "search_pages",
    connectionKey: "notion",
    weight: 0.07,
    avgDurationMs: 320,
    durationVariance: 140,
    sampleInputs: [{ query: "API documentation" }],
    sampleOutputs: [{ results: [], total: 234 }],
  },
  {
    toolName: "get_page",
    connectionKey: "notion",
    weight: 0.06,
    avgDurationMs: 240,
    durationVariance: 90,
    sampleInputs: [{ page_id: "page_123" }],
    sampleOutputs: [{ title: "Documentation", version: 34 }],
  },
  {
    toolName: "create_page",
    connectionKey: "notion",
    weight: 0.03,
    avgDurationMs: 380,
    durationVariance: 140,
    sampleInputs: [{ title: "New Page" }],
    sampleOutputs: [{ page_id: "page_new" }],
  },

  // Grain (12%)
  {
    toolName: "list_meetings",
    connectionKey: "grain",
    weight: 0.05,
    avgDurationMs: 280,
    durationVariance: 100,
    sampleInputs: [{ date_from: "2024-01-01" }],
    sampleOutputs: [{ meetings: [], total: 234 }],
  },
  {
    toolName: "get_transcript",
    connectionKey: "grain",
    weight: 0.04,
    avgDurationMs: 420,
    durationVariance: 180,
    sampleInputs: [{ meeting_id: "meet_123" }],
    sampleOutputs: [{ transcript: "...", duration_minutes: 87 }],
  },
  {
    toolName: "search_meetings",
    connectionKey: "grain",
    weight: 0.03,
    avgDurationMs: 380,
    durationVariance: 150,
    sampleInputs: [{ query: "compliance" }],
    sampleOutputs: [{ results: [], total: 67 }],
  },

  // Slack (8%)
  {
    toolName: "post_message",
    connectionKey: "slack",
    weight: 0.03,
    avgDurationMs: 240,
    durationVariance: 90,
    sampleInputs: [{ channel: "#engineering", text: "Update..." }],
    sampleOutputs: [{ ok: true, ts: "1234567890.123456" }],
  },
  {
    toolName: "list_channels",
    connectionKey: "slack",
    weight: 0.02,
    avgDurationMs: 180,
    durationVariance: 60,
    sampleInputs: [{}],
    sampleOutputs: [{ channels: [], total: 42 }],
  },
  {
    toolName: "get_channel_history",
    connectionKey: "slack",
    weight: 0.02,
    avgDurationMs: 210,
    durationVariance: 80,
    sampleInputs: [{ channel: "C123456" }],
    sampleOutputs: [{ messages: [], has_more: true }],
  },

  // Gmail (9%)
  {
    toolName: "send_email",
    connectionKey: "gmail",
    weight: 0.04,
    avgDurationMs: 340,
    durationVariance: 120,
    sampleInputs: [{ to: "user@example.com", subject: "Report" }],
    sampleOutputs: [{ id: "msg_123", threadId: "thread_456" }],
  },
  {
    toolName: "list_emails",
    connectionKey: "gmail",
    weight: 0.03,
    avgDurationMs: 280,
    durationVariance: 100,
    sampleInputs: [{ query: "is:unread" }],
    sampleOutputs: [{ messages: [], resultSizeEstimate: 42 }],
  },
  {
    toolName: "get_email",
    connectionKey: "gmail",
    weight: 0.02,
    avgDurationMs: 210,
    durationVariance: 80,
    sampleInputs: [{ id: "msg_123" }],
    sampleOutputs: [{ subject: "...", from: "..." }],
  },

  // Brasil API (6%)
  {
    toolName: "get_bank_info",
    connectionKey: "brasilApi",
    weight: 0.02,
    avgDurationMs: 180,
    durationVariance: 70,
    sampleInputs: [{ code: "341" }],
    sampleOutputs: [{ name: "Itaú", fullName: "Itaú Unibanco" }],
  },
  {
    toolName: "get_cep",
    connectionKey: "brasilApi",
    weight: 0.02,
    avgDurationMs: 150,
    durationVariance: 50,
    sampleInputs: [{ cep: "01310100" }],
    sampleOutputs: [{ street: "Av. Paulista", city: "São Paulo" }],
  },
  {
    toolName: "get_cnpj",
    connectionKey: "brasilApi",
    weight: 0.02,
    avgDurationMs: 210,
    durationVariance: 80,
    sampleInputs: [{ cnpj: "00000000000191" }],
    sampleOutputs: [{ razao_social: "Banco do Brasil" }],
  },

  // Jira (8%)
  {
    toolName: "create_issue",
    connectionKey: "jira",
    weight: 0.03,
    avgDurationMs: 340,
    durationVariance: 120,
    sampleInputs: [{ project: "DECO", summary: "Bug fix" }],
    sampleOutputs: [{ id: "10001", key: "DECO-123" }],
  },
  {
    toolName: "search_issues",
    connectionKey: "jira",
    weight: 0.03,
    avgDurationMs: 280,
    durationVariance: 100,
    sampleInputs: [{ jql: "project = DECO" }],
    sampleOutputs: [{ issues: [], total: 234 }],
  },
  {
    toolName: "get_issue",
    connectionKey: "jira",
    weight: 0.02,
    avgDurationMs: 210,
    durationVariance: 80,
    sampleInputs: [{ key: "DECO-123" }],
    sampleOutputs: [{ summary: "...", status: "In Progress" }],
  },

  // Apify (5%)
  {
    toolName: "run_actor",
    connectionKey: "apify",
    weight: 0.02,
    avgDurationMs: 8500,
    durationVariance: 3000,
    sampleInputs: [{ actor_id: "apify/web-scraper" }],
    sampleOutputs: [{ run_id: "run_123", status: "SUCCEEDED" }],
  },
  {
    toolName: "get_dataset",
    connectionKey: "apify",
    weight: 0.015,
    avgDurationMs: 450,
    durationVariance: 180,
    sampleInputs: [{ dataset_id: "dataset_rates" }],
    sampleOutputs: [{ items: [], total: 1247 }],
  },
];

const CONNECTION_TO_GATEWAY: Record<string, string> = {
  github: "devGateway",
  cloudflare: "devGateway",
  aws: "devGateway",
  openrouter: "llm",
  perplexity: "llm",
  notion: "compliance",
  grain: "compliance",
  apify: "dataGateway",
  brasilApi: "dataGateway",
  gmail: "allAccess",
  slack: "allAccess",
  jira: "allAccess",
};

function weightedRandom<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

function generateSyntheticLogs(targetCount: number): MonitoringLog[] {
  const logs: MonitoringLog[] = [];
  const userWeights = Object.entries(USER_ACTIVITY_WEIGHTS).map(
    ([key, weight]) => ({ key, weight }),
  );

  // Pre-calculate logs per day with realistic distribution
  const logsPerDay: number[] = [];
  const totalDays = 30;

  for (let day = 0; day < totalDays; day++) {
    const now = new Date();
    const targetDate = new Date(now.getTime() - day * TIME.DAY);
    const dayOfWeek = targetDate.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    // Special spike days (deployments, incidents)
    const isSpikeDay = [2, 7, 14, 21, 28].includes(day);

    // Calculate base activity for this day
    let dayMultiplier = 1.0;
    if (isWeekend) {
      dayMultiplier = 0.3; // 30% activity on weekends (visible valley)
    } else if (isSpikeDay) {
      dayMultiplier = 2.5; // 250% activity on spike days (visible peak)
    } else {
      // Normal weekdays with slight variation
      dayMultiplier = 0.85 + Math.random() * 0.3; // 85-115% of base
    }

    logsPerDay.push(dayMultiplier);
  }

  // Normalize to hit target count
  const totalMultiplier = logsPerDay.reduce((sum, m) => sum + m, 0);
  const logsPerDayFinal = logsPerDay.map((m) =>
    Math.floor((m / totalMultiplier) * targetCount),
  );

  // Generate logs for each day
  for (let day = 0; day < totalDays; day++) {
    const logsForThisDay = logsPerDayFinal[day] || 0;

    for (let logIdx = 0; logIdx < logsForThisDay; logIdx++) {
      const template = weightedRandom(TOOL_TEMPLATES);
      const userEntry = weightedRandom(userWeights);
      const isError = Math.random() < 0.08;

      // Create realistic hourly patterns with clear peaks
      // Peak hours: 9-11am (morning peak), 2-4pm (afternoon peak)
      // Low activity: 12-1pm (lunch), 5pm-7am (evening/night)
      let hourOffset: number;
      const hourPattern = Math.random();

      if (hourPattern < 0.25) {
        // 25% - Morning peak (9-11am) - HIGHEST activity
        hourOffset = 9 + Math.random() * 2;
      } else if (hourPattern < 0.45) {
        // 20% - Afternoon peak (2-4pm) - HIGH activity
        hourOffset = 14 + Math.random() * 2;
      } else if (hourPattern < 0.6) {
        // 15% - Early morning ramp-up (7-9am)
        hourOffset = 7 + Math.random() * 2;
      } else if (hourPattern < 0.75) {
        // 15% - Late afternoon (4-6pm)
        hourOffset = 16 + Math.random() * 2;
      } else if (hourPattern < 0.85) {
        // 10% - Lunch dip (12-2pm) - LOWER activity
        hourOffset = 12 + Math.random() * 2;
      } else if (hourPattern < 0.93) {
        // 8% - Evening (6-10pm) - LOW activity
        hourOffset = 18 + Math.random() * 4;
      } else {
        // 7% - Night/early morning (10pm-7am) - MINIMAL activity
        const nightHour = Math.random() * 9;
        hourOffset = nightHour < 2 ? 22 + nightHour : nightHour - 2;
      }

      // Add minute/second variation for spreading within the hour
      const minuteOffset = Math.random() * 60;
      const secondOffset = Math.random() * 60;

      // Calculate total offset in milliseconds
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
          ? { error: "Internal error" }
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
        userKey: userEntry.key,
        userAgent: "mesh-client/1.0",
        gatewayKey:
          CONNECTION_TO_GATEWAY[template.connectionKey] || "allAccess",
        properties: template.properties,
      });
    }
  }

  return logs.sort((a, b) => a.offsetMs - b.offsetMs);
}

// =============================================================================
// Seed Function
// =============================================================================

export const DECO_BANK_SLUG = "deco-bank";

export async function seedDecoBank(
  db: Kysely<Database>,
): Promise<OrgSeedResult> {
  // Generate ~1M synthetic logs + static story logs
  // This simulates high-volume production usage (200k/day peak, 1M over 30 days)
  const syntheticLogs = generateSyntheticLogs(1_000_000);
  const allLogs = [...STATIC_LOGS, ...syntheticLogs];

  const config: OrgConfig = {
    orgName: "Deco Bank",
    orgSlug: DECO_BANK_SLUG,
    users: USERS,
    apiKeys: [
      { userKey: "cto", name: "CTO API Key" },
      { userKey: "techLead", name: "Tech Lead API Key" },
    ],
    connections: CONNECTIONS,
    gateways: GATEWAYS,
    gatewayConnections: [
      // Default Hub with well-known connections (production-like)
      { gatewayKey: "defaultHub", connectionKey: "meshMcp" },
      { gatewayKey: "defaultHub", connectionKey: "mcpRegistry" },
      { gatewayKey: "defaultHub", connectionKey: "decoStore" },
      // LLM Gateway
      { gatewayKey: "llm", connectionKey: "openrouter" },
    ],
    logs: allLogs,
    ownerUserKey: "cto",
  };

  return createOrg(db, config);
}
