import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import type {
  PrivateRegistryDatabase,
  MonitorResultEntity,
  MonitorResultStatus,
  MonitorRunConfigSnapshot,
  MonitorRunEntity,
  MonitorRunStatus,
  MonitorToolResult,
} from "./types";

type RawRunRow = Selectable<
  PrivateRegistryDatabase["private_registry_monitor_run"]
>;
type RawResultRow = Selectable<
  PrivateRegistryDatabase["private_registry_monitor_result"]
>;

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class MonitorRunStorage {
  constructor(private db: Kysely<PrivateRegistryDatabase>) {}

  async create(input: {
    organization_id: string;
    status?: MonitorRunStatus;
    config_snapshot?: MonitorRunConfigSnapshot | null;
    total_items?: number;
    started_at?: string | null;
  }): Promise<MonitorRunEntity> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const row: Insertable<
      PrivateRegistryDatabase["private_registry_monitor_run"]
    > = {
      id,
      organization_id: input.organization_id,
      status: input.status ?? "pending",
      config_snapshot: input.config_snapshot
        ? JSON.stringify(input.config_snapshot)
        : null,
      total_items: input.total_items ?? 0,
      tested_items: 0,
      passed_items: 0,
      failed_items: 0,
      skipped_items: 0,
      current_item_id: null,
      started_at: input.started_at ?? null,
      finished_at: null,
      created_at: now,
    };

    await this.db
      .insertInto("private_registry_monitor_run")
      .values(row)
      .execute();
    const created = await this.findById(input.organization_id, id);
    if (!created) {
      throw new Error(`Failed to create monitor run ${id}`);
    }
    return created;
  }

  async findById(
    organizationId: string,
    id: string,
  ): Promise<MonitorRunEntity | null> {
    const row = await this.db
      .selectFrom("private_registry_monitor_run")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.deserializeRun(row as RawRunRow) : null;
  }

  async list(
    organizationId: string,
    query: {
      limit?: number;
      offset?: number;
      status?: MonitorRunStatus;
    } = {},
  ): Promise<{ items: MonitorRunEntity[]; totalCount: number }> {
    let listQuery = this.db
      .selectFrom("private_registry_monitor_run")
      .selectAll()
      .where("organization_id", "=", organizationId);

    let countQuery = this.db
      .selectFrom("private_registry_monitor_run")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("organization_id", "=", organizationId);

    if (query.status) {
      listQuery = listQuery.where("status", "=", query.status);
      countQuery = countQuery.where("status", "=", query.status);
    }

    const totalCountRow = await countQuery.executeTakeFirst();
    const totalCount = Number(totalCountRow?.count ?? 0);

    const rows = await listQuery
      .orderBy("created_at", "desc")
      .limit(query.limit ?? 24)
      .offset(query.offset ?? 0)
      .execute();

    return {
      items: rows.map((row) => this.deserializeRun(row as RawRunRow)),
      totalCount,
    };
  }

  async update(
    organizationId: string,
    id: string,
    patch: {
      total_items?: number;
      status?: MonitorRunStatus;
      tested_items?: number;
      passed_items?: number;
      failed_items?: number;
      skipped_items?: number;
      current_item_id?: string | null;
      started_at?: string | null;
      finished_at?: string | null;
    },
  ): Promise<MonitorRunEntity> {
    const update: Updateable<
      PrivateRegistryDatabase["private_registry_monitor_run"]
    > = {};

    if (patch.total_items !== undefined) update.total_items = patch.total_items;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.tested_items !== undefined)
      update.tested_items = patch.tested_items;
    if (patch.passed_items !== undefined)
      update.passed_items = patch.passed_items;
    if (patch.failed_items !== undefined)
      update.failed_items = patch.failed_items;
    if (patch.skipped_items !== undefined)
      update.skipped_items = patch.skipped_items;
    if (patch.current_item_id !== undefined)
      update.current_item_id = patch.current_item_id;
    if (patch.started_at !== undefined) update.started_at = patch.started_at;
    if (patch.finished_at !== undefined) update.finished_at = patch.finished_at;

    await this.db
      .updateTable("private_registry_monitor_run")
      .set(update)
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .execute();

    const updated = await this.findById(organizationId, id);
    if (!updated) {
      throw new Error(`Monitor run not found: ${id}`);
    }
    return updated;
  }

  private deserializeRun(row: RawRunRow): MonitorRunEntity {
    return {
      id: row.id,
      organization_id: row.organization_id,
      status: row.status,
      config_snapshot: safeJsonParse<MonitorRunConfigSnapshot | null>(
        row.config_snapshot,
        null,
      ),
      total_items: Number(row.total_items ?? 0),
      tested_items: Number(row.tested_items ?? 0),
      passed_items: Number(row.passed_items ?? 0),
      failed_items: Number(row.failed_items ?? 0),
      skipped_items: Number(row.skipped_items ?? 0),
      current_item_id: row.current_item_id,
      started_at: row.started_at,
      finished_at: row.finished_at,
      created_at: row.created_at,
    };
  }
}

export class MonitorResultStorage {
  constructor(private db: Kysely<PrivateRegistryDatabase>) {}

  async create(input: {
    run_id: string;
    organization_id: string;
    item_id: string;
    item_title: string;
    status: MonitorResultStatus;
    error_message?: string | null;
    connection_ok?: boolean;
    tools_listed?: boolean;
    tool_results?: MonitorToolResult[];
    agent_summary?: string | null;
    duration_ms?: number;
    action_taken?: string;
  }): Promise<MonitorResultEntity> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const row: Insertable<
      PrivateRegistryDatabase["private_registry_monitor_result"]
    > = {
      id,
      run_id: input.run_id,
      organization_id: input.organization_id,
      item_id: input.item_id,
      item_title: input.item_title,
      status: input.status,
      error_message: input.error_message ?? null,
      connection_ok: input.connection_ok ? 1 : 0,
      tools_listed: input.tools_listed ? 1 : 0,
      tool_results: input.tool_results
        ? JSON.stringify(input.tool_results)
        : null,
      agent_summary: input.agent_summary ?? null,
      duration_ms: input.duration_ms ?? 0,
      action_taken: input.action_taken ?? "none",
      tested_at: now,
    };

    await this.db
      .insertInto("private_registry_monitor_result")
      .values(row)
      .execute();
    const created = await this.findById(input.organization_id, id);
    if (!created) {
      throw new Error("Failed to create test result");
    }
    return created;
  }

  async findById(
    organizationId: string,
    id: string,
  ): Promise<MonitorResultEntity | null> {
    const row = await this.db
      .selectFrom("private_registry_monitor_result")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.deserialize(row as RawResultRow) : null;
  }

  async listByRun(
    organizationId: string,
    runId: string,
    query: {
      status?: MonitorResultStatus;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ items: MonitorResultEntity[]; totalCount: number }> {
    let listQuery = this.db
      .selectFrom("private_registry_monitor_result")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("run_id", "=", runId);

    let countQuery = this.db
      .selectFrom("private_registry_monitor_result")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("organization_id", "=", organizationId)
      .where("run_id", "=", runId);

    if (query.status) {
      listQuery = listQuery.where("status", "=", query.status);
      countQuery = countQuery.where("status", "=", query.status);
    }

    const totalCountRow = await countQuery.executeTakeFirst();
    const totalCount = Number(totalCountRow?.count ?? 0);

    const rows = await listQuery
      .orderBy("tested_at", "desc")
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0)
      .execute();

    return {
      items: rows.map((row) => this.deserialize(row as RawResultRow)),
      totalCount,
    };
  }

  async update(
    organizationId: string,
    id: string,
    patch: {
      status?: MonitorResultStatus;
      error_message?: string | null;
      connection_ok?: boolean;
      tools_listed?: boolean;
      tool_results?: MonitorToolResult[];
      agent_summary?: string | null;
      duration_ms?: number;
      action_taken?: string;
    },
  ): Promise<MonitorResultEntity> {
    const update: Updateable<
      PrivateRegistryDatabase["private_registry_monitor_result"]
    > = {};

    if (patch.status !== undefined) update.status = patch.status;
    if (patch.error_message !== undefined)
      update.error_message = patch.error_message;
    if (patch.connection_ok !== undefined)
      update.connection_ok = patch.connection_ok ? 1 : 0;
    if (patch.tools_listed !== undefined)
      update.tools_listed = patch.tools_listed ? 1 : 0;
    if (patch.tool_results !== undefined)
      update.tool_results = JSON.stringify(patch.tool_results);
    if (patch.agent_summary !== undefined)
      update.agent_summary = patch.agent_summary;
    if (patch.duration_ms !== undefined) update.duration_ms = patch.duration_ms;
    if (patch.action_taken !== undefined)
      update.action_taken = patch.action_taken;

    await this.db
      .updateTable("private_registry_monitor_result")
      .set(update)
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .execute();

    const updated = await this.findById(organizationId, id);
    if (!updated) {
      throw new Error(`Monitor result not found: ${id}`);
    }
    return updated;
  }

  private deserialize(row: RawResultRow): MonitorResultEntity {
    return {
      id: row.id,
      run_id: row.run_id,
      organization_id: row.organization_id,
      item_id: row.item_id,
      item_title: row.item_title,
      status: row.status,
      error_message: row.error_message,
      connection_ok: row.connection_ok === 1,
      tools_listed: row.tools_listed === 1,
      tool_results: safeJsonParse<MonitorToolResult[]>(row.tool_results, []),
      agent_summary: row.agent_summary,
      duration_ms: Number(row.duration_ms ?? 0),
      action_taken: row.action_taken,
      tested_at: row.tested_at,
    };
  }
}
