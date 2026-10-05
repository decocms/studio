/**
 * The project sidebar's two documents: an org's folders, and each member's
 * pins and hides. See migration 230 and `@decocms/shared/project-sidebar`.
 */

import type { Kysely } from "kysely";
import type { z } from "zod";
import {
  EMPTY_SIDEBAR_PREFERENCES,
  normalizeProjectFolders,
  normalizeSidebarPreferences,
  ProjectFoldersSchema,
  SidebarPreferencesSchema,
  type ProjectFolder,
  type SidebarPreferences,
} from "@decocms/shared/project-sidebar";
import type { Database } from "./types";

/**
 * jsonb comes back parsed from pg, or as text from older drivers. Validated
 * against its schema: a row written by an older app version or edited by
 * hand must not reach a reader as an unchecked cast.
 */
function parse<T>(value: unknown, schema: z.ZodType<T>): T {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return schema.parse(parsed);
}

export class ProjectSidebarStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async getFolders(organizationId: string): Promise<ProjectFolder[]> {
    const row = await this.db
      .selectFrom("org_project_folders")
      .select("folders")
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? parse(row.folders, ProjectFoldersSchema) : [];
  }

  async setFolders(
    organizationId: string,
    folders: readonly ProjectFolder[],
  ): Promise<ProjectFolder[]> {
    const next = normalizeProjectFolders(folders);
    const json = JSON.stringify(next);
    const now = new Date().toISOString();
    await this.db
      .insertInto("org_project_folders")
      .values({
        organization_id: organizationId,
        folders: json,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .column("organization_id")
          .doUpdateSet({ folders: json, updated_at: now }),
      )
      .execute();
    return next;
  }

  async getPreferences(
    userId: string,
    organizationId: string,
  ): Promise<SidebarPreferences> {
    const row = await this.db
      .selectFrom("user_sidebar_preferences")
      .select("preferences")
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row
      ? {
          ...EMPTY_SIDEBAR_PREFERENCES,
          ...parse(row.preferences, SidebarPreferencesSchema),
        }
      : EMPTY_SIDEBAR_PREFERENCES;
  }

  async setPreferences(
    userId: string,
    organizationId: string,
    preferences: SidebarPreferences,
  ): Promise<SidebarPreferences> {
    const next = normalizeSidebarPreferences(preferences);
    const json = JSON.stringify(next);
    const now = new Date().toISOString();
    await this.db
      .insertInto("user_sidebar_preferences")
      .values({
        user_id: userId,
        organization_id: organizationId,
        preferences: json,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(["user_id", "organization_id"])
          .doUpdateSet({ preferences: json, updated_at: now }),
      )
      .execute();
    return next;
  }

  /** When the member joined the org, for "new to you" in Suggested. */
  async joinedAt(
    userId: string,
    organizationId: string,
  ): Promise<string | null> {
    const row = await this.db
      .selectFrom("member")
      .select("createdAt")
      .where("userId", "=", userId)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst();
    return row ? new Date(row.createdAt).toISOString() : null;
  }
}
