/**
 * Automations Storage
 *
 * Provides database operations for automations and their triggers:
 * - CRUD for automations
 * - Adding/removing triggers (cron and event-based)
 * - Querying active cron triggers and matching event triggers
 *
 * Per-automation / global concurrency live in DBOS queues now — there is no
 * DB-side acquire/release.
 */

import { type Kysely } from "kysely";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import type { Database, Automation, AutomationTrigger } from "./types";

// ============================================================================
// Input Types
// ============================================================================

export interface CreateAutomationInput {
  organization_id: string;
  name: string;
  active?: boolean;
  created_by: string;
  messages: string; // JSON
  models: string; // JSON
  tools?: string | null; // JSON string[] | null = all tools
  temperature?: number;
  max_agent_steps?: number | null; // null = PARENT_STEP_LIMIT default
  virtual_mcp_id: string;
}

export interface UpdateAutomationInput {
  name?: string;
  active?: boolean;
  messages?: string;
  models?: string;
  tools?: string | null;
  temperature?: number;
  max_agent_steps?: number | null;
}

export interface CreateTriggerInput {
  automation_id: string;
  type: "cron" | "event" | "webhook";
  cron_expression?: string | null;
  connection_id?: string | null;
  event_type?: string | null;
  params?: string | null;
  next_run_at?: string | null;
  api_key_id?: string | null;
}

// ============================================================================
// AutomationsStorage Interface
// ============================================================================

export interface AutomationWithTriggerCount extends Automation {
  trigger_count: number;
}

export interface AutomationWithTriggerInfo extends AutomationWithTriggerCount {
  nearest_next_run_at: string | null;
}

export interface AutomationsStorage {
  create(input: CreateAutomationInput): Promise<Automation>;
  findById(id: string, organizationId: string): Promise<Automation | null>;
  list(organizationId: string): Promise<Automation[]>;
  listWithTriggerCounts(
    organizationId: string,
    virtualMcpId?: string | null,
  ): Promise<AutomationWithTriggerInfo[]>;
  update(
    id: string,
    organizationId: string,
    input: UpdateAutomationInput,
  ): Promise<Automation>;
  delete(id: string, organizationId: string): Promise<{ success: boolean }>;
  addTrigger(input: CreateTriggerInput): Promise<AutomationTrigger>;
  removeTrigger(
    triggerId: string,
    automationId: string,
  ): Promise<{ success: boolean }>;
  listTriggers(automationId: string): Promise<AutomationTrigger[]>;
  listTriggersForAutomations(
    automationIds: string[],
  ): Promise<AutomationTrigger[]>;
  findTriggerById(triggerId: string): Promise<AutomationTrigger | null>;
  setTriggerApiKeyId(triggerId: string, apiKeyId: string | null): Promise<void>;
  findActiveEventTriggers(
    connectionId: string,
    eventType: string,
    organizationId: string,
  ): Promise<(AutomationTrigger & { automation: Automation })[]>;
  // Includes inactive automations: reconciler pauses (not deletes) their schedules.
  findAllCronTriggers(): Promise<
    (AutomationTrigger & { automation: Automation })[]
  >;
  updateNextRunAt(triggerId: string, nextRunAt: string | null): Promise<void>;
  createAutomationRunThread(
    automation: Automation,
    triggerId: string | null,
  ): Promise<string>;
  markRunFailed(taskId: string, reason?: string, kind?: string): Promise<void>;
  markRunCompleted(taskId: string): Promise<void>;
  updateTriggerLastRunAt(triggerId: string, lastRunAt: string): Promise<void>;
  deactivateAutomation(id: string): Promise<void>;
  /**
   * Count run threads for an automation grouped into the run-lifecycle buckets,
   * joining `threads` → `automation_triggers`. Backs the per-automation Runs
   * stat cards (total + success rate).
   */
  getRunStats(
    automationId: string,
    organizationId: string,
    opts?: { startDate?: string; endDate?: string },
  ): Promise<AutomationRunStats>;
  /**
   * Most-recent run thread IDs for an automation (newest first), capped by
   * `limit`. Used to aggregate token/cost usage for the stat cards via the
   * monitoring store (keyed by `properties.thread_id`).
   */
  listRunThreadIds(
    automationId: string,
    organizationId: string,
    opts?: { startDate?: string; endDate?: string; limit?: number },
  ): Promise<string[]>;
}

export interface AutomationRunStats {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
}

// ============================================================================
// Row Mapping Helpers
// ============================================================================

function toIsoString(v: Date | string): string {
  return typeof v === "string" ? v : v.toISOString();
}

function automationFromDbRow(row: {
  id: string;
  organization_id: string;
  name: string;
  active: boolean | number;
  created_by: string;
  messages: string;
  models: string;
  tools: string | null;
  temperature: number;
  max_agent_steps: number | null;
  virtual_mcp_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}): Automation {
  return {
    id: row.id,
    organization_id: row.organization_id,
    name: row.name,
    active: !!row.active,
    created_by: row.created_by,
    messages: row.messages,
    models: row.models,
    tools: row.tools ?? null,
    temperature: row.temperature,
    max_agent_steps: row.max_agent_steps ?? null,
    virtual_mcp_id: row.virtual_mcp_id,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  };
}

function triggerFromDbRow(row: {
  id: string;
  automation_id: string;
  type: string;
  cron_expression: string | null;
  connection_id: string | null;
  event_type: string | null;
  params: string | null;
  last_run_at: Date | string | null;
  next_run_at?: Date | string | null;
  api_key_id?: string | null;
  created_at: Date | string;
}): AutomationTrigger {
  return {
    id: row.id,
    automation_id: row.automation_id,
    type: row.type as "cron" | "event" | "webhook",
    cron_expression: row.cron_expression,
    connection_id: row.connection_id,
    event_type: row.event_type,
    params: row.params,
    last_run_at: row.last_run_at ? toIsoString(row.last_run_at) : null,
    next_run_at: row.next_run_at ? toIsoString(row.next_run_at) : null,
    api_key_id: row.api_key_id ?? null,
    created_at: toIsoString(row.created_at),
  };
}

// Shared between findActiveEventTriggers and findAllCronTriggers — both join
// `automations as a` and need the full automation row reconstructed from
// aliased columns. Keeping the alias list in one place means new automation
// columns only need updating here.
const TRIGGER_JOIN_AUTOMATION_COLUMNS = [
  "a.id as a_id",
  "a.organization_id as a_organization_id",
  "a.name as a_name",
  "a.active as a_active",
  "a.created_by as a_created_by",
  "a.messages as a_messages",
  "a.models as a_models",
  "a.tools as a_tools",
  "a.temperature as a_temperature",
  "a.max_agent_steps as a_max_agent_steps",
  "a.virtual_mcp_id as a_virtual_mcp_id",
  "a.created_at as a_created_at",
  "a.updated_at as a_updated_at",
] as const;

function automationFromAliasedRow(row: {
  a_id: string;
  a_organization_id: string;
  a_name: string;
  a_active: boolean | number;
  a_created_by: string;
  a_messages: string;
  a_models: string;
  a_tools: string | null;
  a_temperature: number;
  a_max_agent_steps: number | null;
  a_virtual_mcp_id: string;
  a_created_at: Date | string;
  a_updated_at: Date | string;
}): Automation {
  return automationFromDbRow({
    id: row.a_id,
    organization_id: row.a_organization_id,
    name: row.a_name,
    active: row.a_active,
    created_by: row.a_created_by,
    messages: row.a_messages,
    models: row.a_models,
    tools: row.a_tools,
    temperature: row.a_temperature,
    max_agent_steps: row.a_max_agent_steps,
    virtual_mcp_id: row.a_virtual_mcp_id,
    created_at: row.a_created_at,
    updated_at: row.a_updated_at,
  });
}

// ============================================================================
// KyselyAutomationsStorage Implementation
// ============================================================================

class KyselyAutomationsStorage implements AutomationsStorage {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateAutomationInput): Promise<Automation> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const row = {
      id,
      organization_id: input.organization_id,
      name: input.name,
      active: input.active ?? true,
      created_by: input.created_by,
      messages: input.messages,
      models: input.models,
      tools: input.tools ?? null,
      temperature: input.temperature ?? 0.5,
      max_agent_steps: input.max_agent_steps ?? null,
      virtual_mcp_id: input.virtual_mcp_id,
      created_at: now,
      updated_at: now,
    };

    const result = await this.db
      .insertInto("automations")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return automationFromDbRow(result);
  }

  async findById(
    id: string,
    organizationId: string,
  ): Promise<Automation | null> {
    const row = await this.db
      .selectFrom("automations")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return row ? automationFromDbRow(row) : null;
  }

  async list(organizationId: string): Promise<Automation[]> {
    const rows = await this.db
      .selectFrom("automations")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map(automationFromDbRow);
  }

  async listWithTriggerCounts(
    organizationId: string,
    virtualMcpId?: string | null,
  ): Promise<AutomationWithTriggerInfo[]> {
    let query = this.db
      .selectFrom("automations as a")
      .leftJoin("automation_triggers as t", "t.automation_id", "a.id")
      .select([
        "a.id",
        "a.organization_id",
        "a.name",
        "a.active",
        "a.created_by",
        "a.messages",
        "a.models",
        "a.tools",
        "a.temperature",
        "a.max_agent_steps",
        "a.virtual_mcp_id",
        "a.created_at",
        "a.updated_at",
      ])
      .select((eb) => eb.fn.count("t.id").as("trigger_count"))
      .select((eb) => eb.fn.min("t.next_run_at").as("nearest_next_run_at"))
      .where("a.organization_id", "=", organizationId);

    if (virtualMcpId) {
      query = query.where("a.virtual_mcp_id", "=", virtualMcpId);
    }

    const rows = await query
      .groupBy([
        "a.id",
        "a.organization_id",
        "a.name",
        "a.active",
        "a.created_by",
        "a.messages",
        "a.models",
        "a.tools",
        "a.temperature",
        "a.max_agent_steps",
        "a.virtual_mcp_id",
        "a.created_at",
        "a.updated_at",
      ])
      .orderBy("a.created_at", "desc")
      .execute();

    return rows.map((row) => ({
      ...automationFromDbRow(row),
      trigger_count: Number(row.trigger_count),
      nearest_next_run_at: row.nearest_next_run_at
        ? toIsoString(row.nearest_next_run_at as unknown as string)
        : null,
    }));
  }

  async update(
    id: string,
    organizationId: string,
    input: UpdateAutomationInput,
  ): Promise<Automation> {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = { updated_at: now };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.active !== undefined) updateData.active = input.active;
    if (input.messages !== undefined) updateData.messages = input.messages;
    if (input.models !== undefined) updateData.models = input.models;
    if (input.tools !== undefined) updateData.tools = input.tools;
    if (input.temperature !== undefined)
      updateData.temperature = input.temperature;
    if (input.max_agent_steps !== undefined)
      updateData.max_agent_steps = input.max_agent_steps;

    await this.db
      .updateTable("automations")
      .set(updateData)
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();

    const automation = await this.findById(id, organizationId);
    if (!automation) {
      throw new Error("Automation not found after update");
    }

    return automation;
  }

  async delete(
    id: string,
    organizationId: string,
  ): Promise<{ success: boolean }> {
    const result = await this.db
      .deleteFrom("automations")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return { success: (result.numDeletedRows ?? 0n) > 0n };
  }

  async addTrigger(input: CreateTriggerInput): Promise<AutomationTrigger> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const row = {
      id,
      automation_id: input.automation_id,
      type: input.type,
      cron_expression: input.cron_expression ?? null,
      connection_id: input.connection_id ?? null,
      event_type: input.event_type ?? null,
      params: input.params ?? null,
      last_run_at: null,
      next_run_at: input.next_run_at ?? null,
      api_key_id: input.api_key_id ?? null,
      created_at: now,
    };

    const result = await this.db
      .insertInto("automation_triggers")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return triggerFromDbRow(result);
  }

  async removeTrigger(
    triggerId: string,
    automationId: string,
  ): Promise<{ success: boolean }> {
    const result = await this.db
      .deleteFrom("automation_triggers")
      .where("id", "=", triggerId)
      .where("automation_id", "=", automationId)
      .executeTakeFirst();

    return { success: (result.numDeletedRows ?? 0n) > 0n };
  }

  async listTriggers(automationId: string): Promise<AutomationTrigger[]> {
    const rows = await this.db
      .selectFrom("automation_triggers")
      .selectAll()
      .where("automation_id", "=", automationId)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map(triggerFromDbRow);
  }

  async listTriggersForAutomations(
    automationIds: string[],
  ): Promise<AutomationTrigger[]> {
    if (automationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("automation_triggers")
      .selectAll()
      .where("automation_id", "in", automationIds)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map(triggerFromDbRow);
  }

  async findTriggerById(triggerId: string): Promise<AutomationTrigger | null> {
    const row = await this.db
      .selectFrom("automation_triggers")
      .selectAll()
      .where("id", "=", triggerId)
      .executeTakeFirst();

    return row ? triggerFromDbRow(row) : null;
  }

  async setTriggerApiKeyId(
    triggerId: string,
    apiKeyId: string | null,
  ): Promise<void> {
    await this.db
      .updateTable("automation_triggers")
      .set({ api_key_id: apiKeyId })
      .where("id", "=", triggerId)
      .execute();
  }

  async findActiveEventTriggers(
    connectionId: string,
    eventType: string,
    organizationId: string,
  ): Promise<(AutomationTrigger & { automation: Automation })[]> {
    const rows = await this.db
      .selectFrom("automation_triggers as t")
      .innerJoin("automations as a", "a.id", "t.automation_id")
      .select([
        "t.id",
        "t.automation_id",
        "t.type",
        "t.cron_expression",
        "t.connection_id",
        "t.event_type",
        "t.params",
        "t.last_run_at",
        "t.api_key_id",
        "t.created_at",
        ...TRIGGER_JOIN_AUTOMATION_COLUMNS,
      ])
      .where("t.type", "=", "event")
      .where("t.connection_id", "=", connectionId)
      .where("t.event_type", "=", eventType)
      .where("a.organization_id", "=", organizationId)
      .where("a.active", "=", true)
      .execute();

    return rows.map((row) => ({
      ...triggerFromDbRow(row),
      automation: automationFromAliasedRow(row),
    }));
  }

  async findAllCronTriggers(): Promise<
    (AutomationTrigger & { automation: Automation })[]
  > {
    const rows = await this.db
      .selectFrom("automation_triggers as t")
      .innerJoin("automations as a", "a.id", "t.automation_id")
      .select([
        "t.id",
        "t.automation_id",
        "t.type",
        "t.cron_expression",
        "t.connection_id",
        "t.event_type",
        "t.params",
        "t.last_run_at",
        "t.api_key_id",
        "t.created_at",
        ...TRIGGER_JOIN_AUTOMATION_COLUMNS,
      ])
      .where("t.type", "=", "cron")
      .execute();

    return rows.map((row) => ({
      ...triggerFromDbRow(row),
      automation: automationFromAliasedRow(row),
    }));
  }

  async updateNextRunAt(
    triggerId: string,
    nextRunAt: string | null,
  ): Promise<void> {
    await this.db
      .updateTable("automation_triggers")
      .set({ next_run_at: nextRunAt })
      .where("id", "=", triggerId)
      .execute();
  }

  async createAutomationRunThread(
    automation: Automation,
    triggerId: string | null,
  ): Promise<string> {
    const taskId = generatePrefixedId("thrd");
    const now = new Date().toISOString();
    await this.db
      .insertInto("threads")
      .values({
        id: taskId,
        organization_id: automation.organization_id,
        title: `Automation: ${automation.name}`,
        description: null,
        status: "in_progress",
        trigger_id: triggerId,
        virtual_mcp_id: automation.virtual_mcp_id,
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        hidden: false,
        // Pin v2 (the only write path). Automation runs don't go through the
        // routes.ts first-message site that pins user-message threads v2, so
        // without this they default to v1 — and the consume step (sole terminal
        // writer now) skips v1 runs, so the automation would never complete.
        message_storage_version: 2,
        created_at: now,
        updated_at: now,
        created_by: automation.created_by,
        updated_by: null,
      })
      .execute();
    return taskId;
  }

  async markRunFailed(
    taskId: string,
    reason?: string,
    kind?: string,
  ): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({
        status: "failed",
        updated_at: new Date().toISOString(),
        // Record WHY the fire failed so the thread doesn't show a reason-less
        // "errored" (e.g. a 5-min timeout abort). Only overwrite when we
        // actually have a reason — never clobber an existing one with null.
        ...(reason != null ? { failure_reason: reason } : {}),
        ...(kind != null ? { failure_kind: kind } : {}),
      })
      .where("id", "=", taskId)
      .where("status", "=", "in_progress")
      .execute();
  }

  async markRunCompleted(taskId: string): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ status: "completed", updated_at: new Date().toISOString() })
      .where("id", "=", taskId)
      .where("status", "=", "in_progress")
      .execute();
  }

  async updateTriggerLastRunAt(
    triggerId: string,
    lastRunAt: string,
  ): Promise<void> {
    await this.db
      .updateTable("automation_triggers")
      .set({ last_run_at: lastRunAt })
      .where("id", "=", triggerId)
      .execute();
  }

  async deactivateAutomation(id: string): Promise<void> {
    await this.db
      .updateTable("automations")
      .set({ active: false, updated_at: new Date().toISOString() })
      .where("id", "=", id)
      .where("active", "=", true)
      .execute();
  }

  async getRunStats(
    automationId: string,
    organizationId: string,
    opts?: { startDate?: string; endDate?: string },
  ): Promise<AutomationRunStats> {
    let query = this.db
      .selectFrom("threads as th")
      .innerJoin("automation_triggers as t", "t.id", "th.trigger_id")
      .select("th.status")
      .select((eb) => eb.fn.count("th.id").as("count"))
      .where("t.automation_id", "=", automationId)
      .where("th.organization_id", "=", organizationId)
      .where("th.hidden", "=", false)
      .groupBy("th.status");

    if (opts?.startDate) {
      query = query.where(
        "th.created_at",
        ">=",
        opts.startDate as unknown as Date,
      );
    }
    if (opts?.endDate) {
      query = query.where(
        "th.created_at",
        "<=",
        opts.endDate as unknown as Date,
      );
    }

    const rows = await query.execute();

    const stats: AutomationRunStats = {
      total: 0,
      completed: 0,
      failed: 0,
      inProgress: 0,
    };
    for (const row of rows) {
      const count = Number(row.count);
      stats.total += count;
      if (row.status === "completed") stats.completed += count;
      else if (row.status === "failed") stats.failed += count;
      else if (row.status === "in_progress") stats.inProgress += count;
    }
    return stats;
  }

  async listRunThreadIds(
    automationId: string,
    organizationId: string,
    opts?: { startDate?: string; endDate?: string; limit?: number },
  ): Promise<string[]> {
    let query = this.db
      .selectFrom("threads as th")
      .innerJoin("automation_triggers as t", "t.id", "th.trigger_id")
      .select("th.id")
      .where("t.automation_id", "=", automationId)
      .where("th.organization_id", "=", organizationId)
      .where("th.hidden", "=", false)
      .orderBy("th.created_at", "desc")
      .limit(opts?.limit ?? 500);

    if (opts?.startDate) {
      query = query.where(
        "th.created_at",
        ">=",
        opts.startDate as unknown as Date,
      );
    }
    if (opts?.endDate) {
      query = query.where(
        "th.created_at",
        "<=",
        opts.endDate as unknown as Date,
      );
    }

    const rows = await query.execute();
    return rows.map((row) => row.id);
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createAutomationsStorage(
  db: Kysely<Database>,
): AutomationsStorage {
  return new KyselyAutomationsStorage(db);
}
