/**
 * The project sidebar's two documents: an org's folders, and each member's
 * pins and hides. See migration 230 and `@decocms/shared/project-sidebar`.
 */

import type { Kysely } from "kysely";
import {
  EMPTY_SIDEBAR_PREFERENCES,
  normalizeProjectFolders,
  normalizeSidebarPreferences,
  type ProjectFolder,
  type SidebarPreferences,
} from "@decocms/shared/project-sidebar";
import type { Database } from "./types";

/** jsonb comes back parsed from pg, or as text from older drivers. */
function parse<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export class ProjectSidebarStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async getFolders(organizationId: string): Promise<ProjectFolder[]> {
    const row = await this.db
      .selectFrom("org_project_folders")
      .select("folders")
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? parse<ProjectFolder[]>(row.folders) : [];
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
          ...parse<SidebarPreferences>(row.preferences),
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
