/**
 * Member Tags Migration
 *
 * Creates tables for organization-scoped user tags:
 * - organization_tags: Normalized tag definitions per organization
 * - member_tags: Junction table linking members to tags
 *
 * Tags are used for:
 * - Business unit separation in monitoring
 * - Cost/usage filtering by sector
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create organization_tags table
  // Stores normalized tag definitions per organization
  await db.schema
    .createTable("organization_tags")
    .addColumn("id", "text", (col) => col.primaryKey())
    // CASCADE DELETE: When organization is deleted, tags are automatically removed
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Create member_tags junction table
  // Links members to tags (many-to-many)
  await db.schema
    .createTable("member_tags")
    .addColumn("id", "text", (col) => col.primaryKey())
    // CASCADE DELETE: When member is deleted, their tag assignments are removed
    .addColumn("member_id", "text", (col) =>
      col.notNull().references("member.id").onDelete("cascade"),
    )
    // CASCADE DELETE: When tag is deleted, all assignments are removed
    .addColumn("tag_id", "text", (col) =>
      col.notNull().references("organization_tags.id").onDelete("cascade"),
    )
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Index for querying tags by organization
  await db.schema
    .createIndex("idx_organization_tags_org")
    .on("organization_tags")
    .columns(["organization_id"])
    .execute();

  // Unique constraint on (organization_id, name) to prevent duplicate tag names
  await db.schema
    .createIndex("idx_organization_tags_unique_name")
    .on("organization_tags")
    .columns(["organization_id", "name"])
    .unique()
    .execute();

  // Index for querying member tags by member
  await db.schema
    .createIndex("idx_member_tags_member")
    .on("member_tags")
    .columns(["member_id"])
    .execute();

  // Index for querying member tags by tag
  await db.schema
    .createIndex("idx_member_tags_tag")
    .on("member_tags")
    .columns(["tag_id"])
    .execute();

  // Unique constraint on (member_id, tag_id) to prevent duplicate assignments
  await db.schema
    .createIndex("idx_member_tags_unique")
    .on("member_tags")
    .columns(["member_id", "tag_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop indexes first
  await db.schema.dropIndex("idx_member_tags_unique").execute();
  await db.schema.dropIndex("idx_member_tags_tag").execute();
  await db.schema.dropIndex("idx_member_tags_member").execute();
  await db.schema.dropIndex("idx_organization_tags_unique_name").execute();
  await db.schema.dropIndex("idx_organization_tags_org").execute();

  // Drop tables in reverse order (junction table first)
  await db.schema.dropTable("member_tags").execute();
  await db.schema.dropTable("organization_tags").execute();
}
