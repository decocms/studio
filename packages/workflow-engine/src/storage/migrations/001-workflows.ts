/**
 * Workflows Plugin - Database Schema
 *
 * Creates tables for:
 * - workflow_collection: Workflow template definitions (reusable)
 * - workflow: Immutable workflow snapshots (created per execution)
 * - workflow_execution: Execution state and lifecycle
 * - workflow_execution_step_result: Per-step results within an execution
 */

import { Kysely, sql } from "kysely";
import type { EngineMigration } from "./index";

export const migration: EngineMigration = {
  name: "001-workflows",

  async up(db: Kysely<unknown>): Promise<void> {
    // workflow_collection: Reusable workflow templates
    await db.schema
      .createTable("workflow_collection")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("organization_id", "text", (col) =>
        col.notNull().references("organization.id").onDelete("cascade"),
      )
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("description", "text")
      .addColumn("virtual_mcp_id", "text", (col) => col.notNull())
      .addColumn("steps", "text", (col) => col.notNull().defaultTo("[]"))
      .addColumn("created_at", "text", (col) =>
        col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .addColumn("updated_at", "text", (col) =>
        col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .addColumn("created_by", "text")
      .addColumn("updated_by", "text")
      .execute();

    await db.schema
      .createIndex("idx_wf_collection_org")
      .ifNotExists()
      .on("workflow_collection")
      .column("organization_id")
      .execute();

    await db.schema
      .createIndex("idx_wf_collection_created_at")
      .ifNotExists()
      .on("workflow_collection")
      .column("created_at")
      .execute();

    // workflow: Immutable snapshot of a workflow definition (one per execution)
    await db.schema
      .createTable("workflow")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("workflow_collection_id", "text")
      .addColumn("organization_id", "text", (col) =>
        col.notNull().references("organization.id").onDelete("cascade"),
      )
      .addColumn("steps", "text", (col) => col.notNull().defaultTo("[]"))
      .addColumn("input", "text")
      .addColumn("virtual_mcp_id", "text", (col) => col.notNull())
      .addColumn("created_at_epoch_ms", "bigint", (col) => col.notNull())
      .addColumn("created_by", "text")
      .execute();

    await db.schema
      .createIndex("idx_workflow_created_at")
      .ifNotExists()
      .on("workflow")
      .column("created_at_epoch_ms")
      .execute();

    await db.schema
      .createIndex("idx_workflow_collection_id")
      .ifNotExists()
      .on("workflow")
      .column("workflow_collection_id")
      .execute();

    // workflow_execution: Execution state
    await db.schema
      .createTable("workflow_execution")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("workflow_id", "text", (col) =>
        col.notNull().references("workflow.id").onDelete("cascade"),
      )
      .addColumn("organization_id", "text", (col) =>
        col.notNull().references("organization.id").onDelete("cascade"),
      )
      .addColumn("status", "text", (col) => col.notNull().defaultTo("enqueued"))
      .addColumn("input", "text")
      .addColumn("output", "text")
      .addColumn("error", "text")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("updated_at", "bigint", (col) => col.notNull())
      .addColumn("start_at_epoch_ms", "bigint")
      .addColumn("started_at_epoch_ms", "bigint")
      .addColumn("completed_at_epoch_ms", "bigint")
      .addColumn("timeout_ms", "bigint")
      .addColumn("deadline_at_epoch_ms", "bigint")
      .addColumn("created_by", "text")
      .execute();

    await db.schema
      .createIndex("idx_wf_execution_status")
      .ifNotExists()
      .on("workflow_execution")
      .column("status")
      .execute();

    await db.schema
      .createIndex("idx_wf_execution_workflow_id")
      .ifNotExists()
      .on("workflow_execution")
      .column("workflow_id")
      .execute();

    await db.schema
      .createIndex("idx_wf_execution_org")
      .ifNotExists()
      .on("workflow_execution")
      .column("organization_id")
      .execute();

    await db.schema
      .createIndex("idx_wf_execution_created_at")
      .ifNotExists()
      .on("workflow_execution")
      .column("created_at")
      .execute();

    // workflow_execution_step_result: Per-step results
    await db.schema
      .createTable("workflow_execution_step_result")
      .ifNotExists()
      .addColumn("execution_id", "text", (col) =>
        col.notNull().references("workflow_execution.id").onDelete("cascade"),
      )
      .addColumn("step_id", "text", (col) => col.notNull())
      .addColumn("started_at_epoch_ms", "bigint")
      .addColumn("completed_at_epoch_ms", "bigint")
      .addColumn("output", "text")
      .addColumn("error", "text")
      .addColumn("raw_tool_output", "text")
      .execute();

    // Composite primary key via unique index
    await db.schema
      .createIndex("idx_wf_step_result_pk")
      .ifNotExists()
      .on("workflow_execution_step_result")
      .columns(["execution_id", "step_id"])
      .unique()
      .execute();

    await db.schema
      .createIndex("idx_wf_step_result_execution")
      .ifNotExists()
      .on("workflow_execution_step_result")
      .column("execution_id")
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    // Drop indexes
    await db.schema
      .dropIndex("idx_wf_step_result_execution")
      .ifExists()
      .execute();
    await db.schema.dropIndex("idx_wf_step_result_pk").ifExists().execute();
    await db.schema
      .dropIndex("idx_wf_execution_created_at")
      .ifExists()
      .execute();
    await db.schema.dropIndex("idx_wf_execution_org").ifExists().execute();
    await db.schema
      .dropIndex("idx_wf_execution_workflow_id")
      .ifExists()
      .execute();
    await db.schema.dropIndex("idx_wf_execution_status").ifExists().execute();
    await db.schema
      .dropIndex("idx_workflow_collection_id")
      .ifExists()
      .execute();
    await db.schema.dropIndex("idx_workflow_created_at").ifExists().execute();
    await db.schema
      .dropIndex("idx_wf_collection_created_at")
      .ifExists()
      .execute();
    await db.schema.dropIndex("idx_wf_collection_org").ifExists().execute();

    // Drop tables (step results and executions first due to FK constraints)
    await db.schema
      .dropTable("workflow_execution_step_result")
      .ifExists()
      .execute();
    await db.schema.dropTable("workflow_execution").ifExists().execute();
    await db.schema.dropTable("workflow").ifExists().execute();
    await db.schema.dropTable("workflow_collection").ifExists().execute();
  },
};
