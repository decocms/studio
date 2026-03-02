import type { Kysely } from "kysely";
import type {
  Database,
  TriggerActionType,
  TriggerRunStatus,
  TriggerType,
} from "./types";

export interface TriggerEntity {
  id: string;
  organizationId: string;
  title: string | null;
  enabled: boolean;
  triggerType: TriggerType;
  cronExpression: string | null;
  eventType: string | null;
  eventFilter: string | null;
  actionType: TriggerActionType;
  connectionId: string | null;
  toolName: string | null;
  toolArguments: string | null;
  agentId: string | null;
  agentPrompt: string | null;
  eventId: string | null;
  subscriptionId: string | null;
  lastRunAt: string | null;
  lastRunStatus: TriggerRunStatus | null;
  lastRunError: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string | null;
}

function toEntity(row: Record<string, unknown>): TriggerEntity {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    title: row.title as string | null,
    enabled: row.enabled === 1,
    triggerType: row.trigger_type as TriggerType,
    cronExpression: row.cron_expression as string | null,
    eventType: row.event_type as string | null,
    eventFilter: row.event_filter as string | null,
    actionType: row.action_type as TriggerActionType,
    connectionId: row.connection_id as string | null,
    toolName: row.tool_name as string | null,
    toolArguments: row.tool_arguments as string | null,
    agentId: row.agent_id as string | null,
    agentPrompt: row.agent_prompt as string | null,
    eventId: row.event_id as string | null,
    subscriptionId: row.subscription_id as string | null,
    lastRunAt: row.last_run_at as string | null,
    lastRunStatus: row.last_run_status as TriggerRunStatus | null,
    lastRunError: row.last_run_error as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    createdBy: row.created_by as string,
    updatedBy: row.updated_by as string | null,
  };
}

export class TriggerStorage {
  constructor(private db: Kysely<Database>) {}

  async create(input: {
    id: string;
    organizationId: string;
    title?: string | null;
    triggerType: TriggerType;
    cronExpression?: string | null;
    eventType?: string | null;
    eventFilter?: string | null;
    actionType: TriggerActionType;
    connectionId?: string | null;
    toolName?: string | null;
    toolArguments?: string | null;
    agentId?: string | null;
    agentPrompt?: string | null;
    createdBy: string;
  }): Promise<TriggerEntity> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("triggers")
      .values({
        id: input.id,
        organization_id: input.organizationId,
        title: input.title ?? null,
        enabled: 1,
        trigger_type: input.triggerType,
        cron_expression: input.cronExpression ?? null,
        event_type: input.eventType ?? null,
        event_filter: input.eventFilter ?? null,
        action_type: input.actionType,
        connection_id: input.connectionId ?? null,
        tool_name: input.toolName ?? null,
        tool_arguments: input.toolArguments ?? null,
        agent_id: input.agentId ?? null,
        agent_prompt: input.agentPrompt ?? null,
        created_at: now,
        updated_at: now,
        created_by: input.createdBy,
      })
      .execute();

    const trigger = await this.get(input.id);
    if (!trigger) throw new Error("Failed to create trigger");
    return trigger;
  }

  async get(id: string): Promise<TriggerEntity | null> {
    const row = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? toEntity(row as Record<string, unknown>) : null;
  }

  async list(organizationId: string): Promise<TriggerEntity[]> {
    const rows = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map((row) => toEntity(row as Record<string, unknown>));
  }

  async update(
    id: string,
    input: {
      title?: string | null;
      enabled?: boolean;
      triggerType?: TriggerType;
      cronExpression?: string | null;
      eventType?: string | null;
      eventFilter?: string | null;
      actionType?: TriggerActionType;
      connectionId?: string | null;
      toolName?: string | null;
      toolArguments?: string | null;
      agentId?: string | null;
      agentPrompt?: string | null;
      eventId?: string | null;
      subscriptionId?: string | null;
      lastRunAt?: string | null;
      lastRunStatus?: TriggerRunStatus | null;
      lastRunError?: string | null;
      updatedBy?: string;
    },
  ): Promise<TriggerEntity> {
    const now = new Date().toISOString();
    const values: Record<string, unknown> = { updated_at: now };

    if (input.title !== undefined) values.title = input.title;
    if (input.enabled !== undefined) values.enabled = input.enabled ? 1 : 0;
    if (input.triggerType !== undefined)
      values.trigger_type = input.triggerType;
    if (input.cronExpression !== undefined)
      values.cron_expression = input.cronExpression;
    if (input.eventType !== undefined) values.event_type = input.eventType;
    if (input.eventFilter !== undefined)
      values.event_filter = input.eventFilter;
    if (input.actionType !== undefined) values.action_type = input.actionType;
    if (input.connectionId !== undefined)
      values.connection_id = input.connectionId;
    if (input.toolName !== undefined) values.tool_name = input.toolName;
    if (input.toolArguments !== undefined)
      values.tool_arguments = input.toolArguments;
    if (input.agentId !== undefined) values.agent_id = input.agentId;
    if (input.agentPrompt !== undefined)
      values.agent_prompt = input.agentPrompt;
    if (input.eventId !== undefined) values.event_id = input.eventId;
    if (input.subscriptionId !== undefined)
      values.subscription_id = input.subscriptionId;
    if (input.lastRunAt !== undefined) values.last_run_at = input.lastRunAt;
    if (input.lastRunStatus !== undefined)
      values.last_run_status = input.lastRunStatus;
    if (input.lastRunError !== undefined)
      values.last_run_error = input.lastRunError;
    if (input.updatedBy !== undefined) values.updated_by = input.updatedBy;

    await this.db
      .updateTable("triggers")
      .set(values)
      .where("id", "=", id)
      .execute();

    const trigger = await this.get(id);
    if (!trigger) throw new Error("Trigger not found");
    return trigger;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("triggers").where("id", "=", id).execute();
  }

  async listEnabled(organizationId: string): Promise<TriggerEntity[]> {
    const rows = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("enabled", "=", 1)
      .execute();

    return rows.map((row) => toEntity(row as Record<string, unknown>));
  }

  async findByEventId(eventId: string): Promise<TriggerEntity | null> {
    const row = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("event_id", "=", eventId)
      .executeTakeFirst();

    return row ? toEntity(row as Record<string, unknown>) : null;
  }

  async findBySubscriptionId(
    subscriptionId: string,
  ): Promise<TriggerEntity | null> {
    const row = await this.db
      .selectFrom("triggers")
      .selectAll()
      .where("subscription_id", "=", subscriptionId)
      .executeTakeFirst();

    return row ? toEntity(row as Record<string, unknown>) : null;
  }
}
