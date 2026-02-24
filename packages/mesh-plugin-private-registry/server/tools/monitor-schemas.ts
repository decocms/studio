import { z } from "zod";
import { RegistryItemSchema } from "./schema";

const MonitorModeSchema = z.enum(["health_check", "tool_call", "full_agent"]);
const MonitorFailureActionSchema = z.enum([
  "none",
  "unlisted",
  "remove_public",
  "remove_private",
  "remove_all",
]);
const MonitorRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const MonitorResultStatusSchema = z.enum([
  "passed",
  "failed",
  "skipped",
  "error",
  "needs_auth",
]);
const MonitorConnectionAuthStatusSchema = z.enum([
  "none",
  "needs_auth",
  "authenticated",
]);

export const RegistryMonitorConfigSchema = z.object({
  monitorMode: MonitorModeSchema.default("health_check"),
  // Backward compat: persisted data may still use "testMode".
  testMode: MonitorModeSchema.optional(),
  onFailure: MonitorFailureActionSchema.default("none"),
  schedule: z.enum(["manual", "cron"]).default("manual"),
  cronExpression: z.string().optional(),
  scheduleEventId: z.string().optional(),
  perMcpTimeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
  perToolTimeoutMs: z.number().int().min(500).max(120_000).default(10_000),
  maxAgentSteps: z.number().int().min(1).max(30).default(15),
  testPublicOnly: z.boolean().default(false),
  testPrivateOnly: z.boolean().default(false),
  includePendingRequests: z.boolean().default(false),
  agentContext: z.string().max(2000).optional(),
  llmConnectionId: z.string().optional(),
  llmModelId: z.string().optional(),
});

/**
 * Parse config with backward compat: migrate legacy "testMode" → "monitorMode".
 */
export function parseMonitorConfig(
  raw: unknown,
): z.infer<typeof RegistryMonitorConfigSchema> {
  const input =
    typeof raw === "object" && raw
      ? ({ ...raw } as Record<string, unknown>)
      : {};
  if (!input.monitorMode && input.testMode) {
    input.monitorMode = input.testMode;
  }
  return RegistryMonitorConfigSchema.parse(input);
}

const MonitorToolResultSchema = z.object({
  toolName: z.string(),
  success: z.boolean(),
  durationMs: z.number(),
  input: z.record(z.string(), z.unknown()).optional(),
  outputPreview: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

const MonitorRunSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  status: MonitorRunStatusSchema,
  config_snapshot: RegistryMonitorConfigSchema.nullable(),
  total_items: z.number(),
  tested_items: z.number(),
  passed_items: z.number(),
  failed_items: z.number(),
  skipped_items: z.number(),
  current_item_id: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  created_at: z.string(),
});

const MonitorResultSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  organization_id: z.string(),
  item_id: z.string(),
  item_title: z.string(),
  status: MonitorResultStatusSchema,
  error_message: z.string().nullable(),
  connection_ok: z.boolean(),
  tools_listed: z.boolean(),
  tool_results: z.array(MonitorToolResultSchema),
  agent_summary: z.string().nullable(),
  duration_ms: z.number(),
  action_taken: z.string(),
  tested_at: z.string(),
});

const MonitorConnectionSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  item_id: z.string(),
  connection_id: z.string(),
  auth_status: MonitorConnectionAuthStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export const RegistryMonitorRunStartInputSchema = z.object({
  config: RegistryMonitorConfigSchema.optional(),
});

export const RegistryMonitorRunStartOutputSchema = z.object({
  run: MonitorRunSchema,
});

export const RegistryMonitorRunCancelInputSchema = z.object({
  runId: z.string(),
});

export const RegistryMonitorRunCancelOutputSchema = z.object({
  run: MonitorRunSchema,
});

export const RegistryMonitorRunListInputSchema = z.object({
  status: MonitorRunStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export const RegistryMonitorRunListOutputSchema = z.object({
  items: z.array(MonitorRunSchema),
  totalCount: z.number(),
});

export const RegistryMonitorRunGetInputSchema = z.object({
  runId: z.string(),
});

export const RegistryMonitorRunGetOutputSchema = z.object({
  run: MonitorRunSchema.nullable(),
});

export const RegistryMonitorResultListInputSchema = z.object({
  runId: z.string(),
  status: MonitorResultStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

export const RegistryMonitorResultListOutputSchema = z.object({
  items: z.array(MonitorResultSchema),
  totalCount: z.number(),
});

export const RegistryMonitorConnectionListInputSchema = z.object({});

export const RegistryMonitorConnectionListOutputSchema = z.object({
  items: z.array(
    z.object({
      mapping: MonitorConnectionSchema,
      item: RegistryItemSchema.nullable(),
      remoteUrl: z.string().nullable(),
      source: z.enum(["store", "request"]),
    }),
  ),
});

export const RegistryMonitorConnectionSyncInputSchema = z.object({});

export const RegistryMonitorConnectionSyncOutputSchema = z.object({
  created: z.number(),
  updated: z.number(),
});

export const RegistryMonitorConnectionUpdateAuthInputSchema = z.object({
  connectionId: z
    .string()
    .describe("The monitor connection ID (connections table)"),
  authStatus: MonitorConnectionAuthStatusSchema.describe("New auth status"),
});

export const RegistryMonitorConnectionUpdateAuthOutputSchema = z.object({
  success: z.boolean(),
});

export const RegistryMonitorScheduleSetInputSchema = z.object({
  cronExpression: z.string().min(1),
  config: RegistryMonitorConfigSchema.optional(),
});

export const RegistryMonitorScheduleSetOutputSchema = z.object({
  scheduleEventId: z.string(),
});

export const RegistryMonitorScheduleCancelInputSchema = z.object({
  scheduleEventId: z.string().min(1),
});

export const RegistryMonitorScheduleCancelOutputSchema = z.object({
  success: z.boolean(),
});

export type RegistryMonitorConfig = z.infer<typeof RegistryMonitorConfigSchema>;
