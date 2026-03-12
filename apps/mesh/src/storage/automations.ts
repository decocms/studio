/**
 * Automations Storage
 *
 * Provides database operations for automations and their triggers:
 * - CRUD for automations
 * - Adding/removing triggers (cron and event-based)
 * - Querying due cron triggers and matching event triggers
 * - Concurrency control for automation runs via tryAcquireRunSlot
 */

import { type Kysely, type SqlBool, sql } from "kysely";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import type { Database, Automation, AutomationTrigger } from "./types";

// ============================================================================
// Input Types
// ============================================================================

export interface CreateAutomationInput {
  organization_id: string;
  name: string;
  active?: boolean;
  created_by: string;
  agent: string; // JSON
  messages: string; // JSON
  models: string; // JSON
  temperature?: number;
  tool_approval_level?: string;
}

export interface UpdateAutomationInput {
  name?: string;
  active?: boolean;
  agent?: string;
  messages?: string;
  models?: string;
  temperature?: number;
  tool_approval_level?: string;
}

export interface CreateTriggerInput {
  automation_id: string;
  type: "cron" | "event";
  cron_expression?: string | null;
  connection_id?: string | null;
  event_type?: string | null;
  params?: string | null;
  next_run_at?: string | null;
}

// ============================================================================
// AutomationsStorage Interface
// ============================================================================

export interface AutomationWithTriggerCount extends Automation {
  trigger_count: number;
}

export interface AutomationsStorage {
  create(input: CreateAutomationInput): Promise<Automation>;
  findById(id: string, organizationId: string): Promise<Automation | null>;
  list(organizationId: string): Promise<Automation[]>;
  listWithTriggerCounts(
    organizationId: string,
  ): Promise<AutomationWithTriggerCount[]>;
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
  findTriggerById(triggerId: string): Promise<AutomationTrigger | null>;
  findActiveEventTriggers(
    connectionId: string,
    eventType: string,
    organizationId: string,
  ): Promise<(AutomationTrigger & { automation: Automation })[]>;
  findDueCronTriggers(
    now: string,
  ): Promise<(AutomationTrigger & { automation: Automation })[]>;
  countInProgressRuns(automationId: string): Promise<number>;
  tryAcquireRunSlot(
    automationId: string,
    triggerId: string | null,
    maxConcurrent: number,
  ): Promise<string | null>;
  markRunFailed(threadId: string): Promise<void>;
  updateTriggerNextRunAt(triggerId: string, nextRunAt: string): Promise<void>;
  deactivateAutomation(id: string): Promise<void>;
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
  agent: string;
  messages: string;
  models: string;
  temperature: number;
  tool_approval_level: string;
  created_at: Date | string;
  updated_at: Date | string;
}): Automation {
  return {
    id: row.id,
    organization_id: row.organization_id,
    name: row.name,
    active: !!row.active,
    created_by: row.created_by,
    agent: row.agent,
    messages: row.messages,
    models: row.models,
    temperature: row.temperature,
    tool_approval_level: row.tool_approval_level,
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
  next_run_at: Date | string | null;
  created_at: Date | string;
}): AutomationTrigger {
  return {
    id: row.id,
    automation_id: row.automation_id,
    type: row.type as "cron" | "event",
    cron_expression: row.cron_expression,
    connection_id: row.connection_id,
    event_type: row.event_type,
    params: row.params,
    next_run_at: row.next_run_at ? toIsoString(row.next_run_at) : null,
    created_at: toIsoString(row.created_at),
  };
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
      agent: input.agent,
      messages: input.messages,
      models: input.models,
      temperature: input.temperature ?? 0.5,
      tool_approval_level: input.tool_approval_level ?? "none",
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
  ): Promise<AutomationWithTriggerCount[]> {
    const rows = await this.db
      .selectFrom("automations as a")
      .leftJoin("automation_triggers as t", "t.automation_id", "a.id")
      .select([
        "a.id",
        "a.organization_id",
        "a.name",
        "a.active",
        "a.created_by",
        "a.agent",
        "a.messages",
        "a.models",
        "a.temperature",
        "a.tool_approval_level",
        "a.created_at",
        "a.updated_at",
      ])
      .select((eb) => eb.fn.count("t.id").as("trigger_count"))
      .where("a.organization_id", "=", organizationId)
      .groupBy([
        "a.id",
        "a.organization_id",
        "a.name",
        "a.active",
        "a.created_by",
        "a.agent",
        "a.messages",
        "a.models",
        "a.temperature",
        "a.tool_approval_level",
        "a.created_at",
        "a.updated_at",
      ])
      .orderBy("a.created_at", "desc")
      .execute();

    return rows.map((row) => ({
      ...automationFromDbRow(row),
      trigger_count: Number(row.trigger_count),
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
    if (input.agent !== undefined) updateData.agent = input.agent;
    if (input.messages !== undefined) updateData.messages = input.messages;
    if (input.models !== undefined) updateData.models = input.models;
    if (input.temperature !== undefined)
      updateData.temperature = input.temperature;
    if (input.tool_approval_level !== undefined)
      updateData.tool_approval_level = input.tool_approval_level;

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
      next_run_at: input.next_run_at ?? null,
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

  async findTriggerById(triggerId: string): Promise<AutomationTrigger | null> {
    const row = await this.db
      .selectFrom("automation_triggers")
      .selectAll()
      .where("id", "=", triggerId)
      .executeTakeFirst();

    return row ? triggerFromDbRow(row) : null;
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
        "t.next_run_at",
        "t.created_at",
        "a.id as a_id",
        "a.organization_id as a_organization_id",
        "a.name as a_name",
        "a.active as a_active",
        "a.created_by as a_created_by",
        "a.agent as a_agent",
        "a.messages as a_messages",
        "a.models as a_models",
        "a.temperature as a_temperature",
        "a.tool_approval_level as a_tool_approval_level",
        "a.created_at as a_created_at",
        "a.updated_at as a_updated_at",
      ])
      .where("t.type", "=", "event")
      .where("t.connection_id", "=", connectionId)
      .where("t.event_type", "=", eventType)
      .where("a.organization_id", "=", organizationId)
      .where("a.active", "=", true)
      .execute();

    return rows.map((row) => ({
      ...triggerFromDbRow(row),
      automation: automationFromDbRow({
        id: row.a_id,
        organization_id: row.a_organization_id,
        name: row.a_name,
        active: row.a_active,
        created_by: row.a_created_by,
        agent: row.a_agent,
        messages: row.a_messages,
        models: row.a_models,
        temperature: row.a_temperature,
        tool_approval_level: row.a_tool_approval_level,
        created_at: row.a_created_at,
        updated_at: row.a_updated_at,
      }),
    }));
  }

  async findDueCronTriggers(
    now: string,
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
        "t.next_run_at",
        "t.created_at",
        "a.id as a_id",
        "a.organization_id as a_organization_id",
        "a.name as a_name",
        "a.active as a_active",
        "a.created_by as a_created_by",
        "a.agent as a_agent",
        "a.messages as a_messages",
        "a.models as a_models",
        "a.temperature as a_temperature",
        "a.tool_approval_level as a_tool_approval_level",
        "a.created_at as a_created_at",
        "a.updated_at as a_updated_at",
      ])
      .where("t.type", "=", "cron")
      .where((eb) =>
        eb.or([
          eb(sql`t.next_run_at`, "<=", now),
          eb("t.next_run_at", "is", null),
        ]),
      )
      .where("a.active", "=", true)
      .execute();

    return rows.map((row) => ({
      ...triggerFromDbRow(row),
      automation: automationFromDbRow({
        id: row.a_id,
        organization_id: row.a_organization_id,
        name: row.a_name,
        active: row.a_active,
        created_by: row.a_created_by,
        agent: row.a_agent,
        messages: row.a_messages,
        models: row.a_models,
        temperature: row.a_temperature,
        tool_approval_level: row.a_tool_approval_level,
        created_at: row.a_created_at,
        updated_at: row.a_updated_at,
      }),
    }));
  }

  async countInProgressRuns(automationId: string): Promise<number> {
    const result = await this.db
      .selectFrom("threads as t")
      .innerJoin("automation_triggers as tr", "tr.id", "t.trigger_id")
      .select((eb) => eb.fn.count("t.id").as("count"))
      .where("tr.automation_id", "=", automationId)
      .where("t.status", "=", "in_progress")
      .executeTakeFirst();

    return Number(result?.count ?? 0);
  }

  async tryAcquireRunSlot(
    automationId: string,
    triggerId: string | null,
    maxConcurrent: number,
  ): Promise<string | null> {
    return await this.db.transaction().execute(async (trx) => {
      // Lock the automation row to prevent race conditions
      const automation = await trx
        .selectFrom("automations")
        .selectAll()
        .where("id", "=", automationId)
        .forUpdate()
        .executeTakeFirst();

      if (!automation || !automation.active) {
        return null;
      }

      // Count in-progress runs within the transaction
      const countResult = await trx
        .selectFrom("threads as t")
        .innerJoin("automation_triggers as tr", "tr.id", "t.trigger_id")
        .select((eb) => eb.fn.count("t.id").as("count"))
        .where("tr.automation_id", "=", automationId)
        .where("t.status", "=", "in_progress")
        .executeTakeFirst();

      const currentCount = Number(countResult?.count ?? 0);

      if (currentCount >= maxConcurrent) {
        return null;
      }

      // Create a thread for this run
      const threadId = generatePrefixedId("thrd");
      const now = new Date().toISOString();

      await trx
        .insertInto("threads")
        .values({
          id: threadId,
          organization_id: automation.organization_id,
          title: `Automation: ${automation.name}`,
          description: null,
          status: "in_progress",
          trigger_id: triggerId,
          hidden: true,
          created_at: now,
          updated_at: now,
          created_by: automation.created_by,
          updated_by: null,
        })
        .execute();

      return threadId;
    });
  }

  async markRunFailed(threadId: string): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ status: "failed", updated_at: new Date().toISOString() })
      .where("id", "=", threadId)
      .where("status", "=", "in_progress")
      .execute();
  }

  async updateTriggerNextRunAt(
    triggerId: string,
    nextRunAt: string,
  ): Promise<void> {
    await this.db
      .updateTable("automation_triggers")
      .set({ next_run_at: nextRunAt })
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
}

// ============================================================================
// Factory
// ============================================================================

export function createAutomationsStorage(
  db: Kysely<Database>,
): AutomationsStorage {
  return new KyselyAutomationsStorage(db);
}
