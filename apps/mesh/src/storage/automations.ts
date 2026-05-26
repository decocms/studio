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
import { generatePrefixedId } from "@/shared/utils/generate-id";
import type {
  Database,
  Automation,
  AutomationKind,
  AutomationTrigger,
} from "./types";

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
  temperature?: number;
  kind: AutomationKind;
  // kind='agent' requires this; kind='tool_call' must omit / set null.
  virtual_mcp_id?: string | null;
  // kind='tool_call' requires these; kind='agent' must omit / set null.
  connection_id?: string | null;
  tool_name?: string | null;
  tool_input?: string | null; // JSON
}

export interface UpdateAutomationInput {
  name?: string;
  active?: boolean;
  messages?: string;
  models?: string;
  temperature?: number;
  // Tool-call edits. Only meaningful on kind='tool_call' rows; kind itself
  // is immutable.
  connection_id?: string;
  tool_name?: string;
  tool_input?: string;
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
  // Spawns a thread for a kind='tool_call' run. Uses empty-string
  // virtual_mcp_id (the same sentinel migration 057 reserves for
  // agent-less threads) and stamps metadata.kind so the UI can render
  // the row + thread detail differently from agent runs.
  createToolCallRunThread(
    automation: Automation,
    triggerId: string | null,
  ): Promise<string>;
  markRunFailed(taskId: string): Promise<void>;
  markRunCompleted(taskId: string): Promise<void>;
  updateTriggerLastRunAt(triggerId: string, lastRunAt: string): Promise<void>;
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
  messages: string;
  models: string;
  temperature: number;
  virtual_mcp_id: string | null;
  kind?: string | null;
  connection_id?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): Automation {
  // Default to 'agent' so rows from older code paths that haven't been updated
  // to select `kind` still type-check at runtime. The DB column itself is
  // NOT NULL with a default of 'agent', so any row read with selectAll() will
  // carry the real value.
  const kind: AutomationKind = row.kind === "tool_call" ? "tool_call" : "agent";
  return {
    id: row.id,
    organization_id: row.organization_id,
    name: row.name,
    active: !!row.active,
    created_by: row.created_by,
    messages: row.messages,
    models: row.models,
    temperature: row.temperature,
    virtual_mcp_id: row.virtual_mcp_id,
    kind,
    connection_id: row.connection_id ?? null,
    tool_name: row.tool_name ?? null,
    tool_input: row.tool_input ?? null,
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
// aliased columns. Keeping the alias list in one place means new columns
// (like kind / tool_call_* in migration 078) only need updating here.
const TRIGGER_JOIN_AUTOMATION_COLUMNS = [
  "a.id as a_id",
  "a.organization_id as a_organization_id",
  "a.name as a_name",
  "a.active as a_active",
  "a.created_by as a_created_by",
  "a.messages as a_messages",
  "a.models as a_models",
  "a.temperature as a_temperature",
  "a.virtual_mcp_id as a_virtual_mcp_id",
  "a.kind as a_kind",
  "a.connection_id as a_connection_id",
  "a.tool_name as a_tool_name",
  "a.tool_input as a_tool_input",
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
  a_temperature: number;
  a_virtual_mcp_id: string | null;
  a_kind: string | null;
  a_connection_id: string | null;
  a_tool_name: string | null;
  a_tool_input: string | null;
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
    temperature: row.a_temperature,
    virtual_mcp_id: row.a_virtual_mcp_id,
    kind: row.a_kind,
    connection_id: row.a_connection_id,
    tool_name: row.a_tool_name,
    tool_input: row.a_tool_input,
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
      temperature: input.temperature ?? 0.5,
      virtual_mcp_id: input.virtual_mcp_id ?? null,
      kind: input.kind,
      connection_id: input.connection_id ?? null,
      tool_name: input.tool_name ?? null,
      tool_input: input.tool_input ?? null,
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
        "a.temperature",
        "a.virtual_mcp_id",
        "a.kind",
        "a.connection_id",
        "a.tool_name",
        "a.tool_input",
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
        "a.temperature",
        "a.virtual_mcp_id",
        "a.kind",
        "a.connection_id",
        "a.tool_name",
        "a.tool_input",
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
    if (input.temperature !== undefined)
      updateData.temperature = input.temperature;
    if (input.connection_id !== undefined)
      updateData.connection_id = input.connection_id;
    if (input.tool_name !== undefined) updateData.tool_name = input.tool_name;
    if (input.tool_input !== undefined)
      updateData.tool_input = input.tool_input;

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
    if (!automation.virtual_mcp_id) {
      // Only agent-kind automations dispatch a chat thread. Tool-call
      // automations spawn their thread via createToolCallRunThread.
      throw new Error(
        "createAutomationRunThread requires an agent-kind automation",
      );
    }
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
        hidden: false,
        created_at: now,
        updated_at: now,
        created_by: automation.created_by,
        updated_by: null,
      })
      .execute();
    return taskId;
  }

  async createToolCallRunThread(
    automation: Automation,
    triggerId: string | null,
  ): Promise<string> {
    if (automation.kind !== "tool_call") {
      throw new Error(
        "createToolCallRunThread requires a tool_call-kind automation",
      );
    }
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
        // No agent; the UI keys off metadata.kind below.
        virtual_mcp_id: "",
        hidden: false,
        metadata: JSON.stringify({ kind: "tool_call_run" }),
        created_at: now,
        updated_at: now,
        created_by: automation.created_by,
        updated_by: null,
      })
      .execute();
    return taskId;
  }

  async markRunFailed(taskId: string): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ status: "failed", updated_at: new Date().toISOString() })
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
}

// ============================================================================
// Factory
// ============================================================================

export function createAutomationsStorage(
  db: Kysely<Database>,
): AutomationsStorage {
  return new KyselyAutomationsStorage(db);
}
