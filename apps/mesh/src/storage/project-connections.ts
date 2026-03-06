/**
 * Project Connections Storage
 *
 * Storage layer for project-connection associations (dependencies).
 * Links projects to organization connections.
 */

import type { Kysely } from "kysely";
import type { Database, ProjectConnection } from "./types";
import type { ProjectConnectionStoragePort } from "./ports";
import { generatePrefixedId } from "@/shared/utils/generate-id";

export class ProjectConnectionsStorage implements ProjectConnectionStoragePort {
  constructor(private readonly db: Kysely<Database>) {}

  private parseRow(row: {
    id: string;
    project_id: string;
    connection_id: string;
    created_at: Date | string;
  }): ProjectConnection {
    return {
      id: row.id,
      projectId: row.project_id,
      connectionId: row.connection_id,
      createdAt: row.created_at,
    };
  }

  async list(projectId: string): Promise<ProjectConnection[]> {
    const rows = await this.db
      .selectFrom("project_connections")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => this.parseRow(row));
  }

  async add(
    projectId: string,
    connectionId: string,
  ): Promise<ProjectConnection> {
    const now = new Date().toISOString();
    const id = generatePrefixedId("pc");

    const result = await this.db
      .insertInto("project_connections")
      .values({
        id,
        project_id: projectId,
        connection_id: connectionId,
        created_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "connection_id"]).doNothing(),
      )
      .returning(["id", "project_id", "connection_id", "created_at"])
      .executeTakeFirst();

    if (result) {
      return this.parseRow(result);
    }

    // Conflict: row already exists, fetch and return it
    const existing = await this.db
      .selectFrom("project_connections")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("connection_id", "=", connectionId)
      .executeTakeFirst();

    if (!existing) {
      throw new Error(
        `Project connection not found after conflict: project=${projectId}, connection=${connectionId}`,
      );
    }

    return this.parseRow(existing);
  }

  async remove(projectId: string, connectionId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("project_connections")
      .where("project_id", "=", projectId)
      .where("connection_id", "=", connectionId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
