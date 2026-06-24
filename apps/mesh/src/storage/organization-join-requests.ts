import type { Kysely } from "kysely";
import type {
  JoinRequestWithUser,
  OrganizationJoinRequestStoragePort,
} from "./ports";
import type {
  Database,
  JoinRequestStatus,
  OrganizationJoinRequest,
} from "./types";

function toEntity(
  record: Record<string, unknown> & {
    id: string;
    organization_id: string;
    user_id: string;
    status: string;
    decided_by: string | null;
    decided_at: Date | string | null;
    created_at: Date;
    updated_at: Date;
  },
): OrganizationJoinRequest {
  return {
    id: record.id,
    organizationId: record.organization_id,
    userId: record.user_id,
    status: record.status as JoinRequestStatus,
    decidedBy: record.decided_by,
    decidedAt: record.decided_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export class OrganizationJoinRequestStorage
  implements OrganizationJoinRequestStoragePort
{
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationJoinRequest> {
    const existing = await this.getPending(organizationId, userId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    try {
      await this.db
        .insertInto("organization_join_requests")
        .values({
          id,
          organization_id: organizationId,
          user_id: userId,
          status: "pending",
          decided_by: null,
          decided_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch (error) {
      // Concurrent request raced past getPending() and lost the partial
      // unique index (status='pending'); fall back to the winner's row.
      if ((error as { code?: string }).code === "23505") {
        const winner = await this.getPending(organizationId, userId);
        if (winner) return winner;
      }
      throw error;
    }

    const result = await this.getById(id);
    if (!result) {
      throw new Error("Failed to create join request");
    }
    return result;
  }

  async getById(id: string): Promise<OrganizationJoinRequest | null> {
    const record = await this.db
      .selectFrom("organization_join_requests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return record ? toEntity(record) : null;
  }

  async getPending(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationJoinRequest | null> {
    const record = await this.db
      .selectFrom("organization_join_requests")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("user_id", "=", userId)
      .where("status", "=", "pending")
      .executeTakeFirst();

    return record ? toEntity(record) : null;
  }

  async listPendingWithUser(
    organizationId: string,
  ): Promise<JoinRequestWithUser[]> {
    const rows = await this.db
      .selectFrom("organization_join_requests as r")
      .innerJoin("user", "user.id", "r.user_id")
      .select([
        "r.id as id",
        "r.organization_id as organization_id",
        "r.user_id as user_id",
        "r.status as status",
        "r.decided_by as decided_by",
        "r.decided_at as decided_at",
        "r.created_at as created_at",
        "r.updated_at as updated_at",
        "user.name as user_name",
        "user.email as user_email",
        "user.image as user_image",
      ])
      .where("r.organization_id", "=", organizationId)
      .where("r.status", "=", "pending")
      .orderBy("r.created_at", "asc")
      .execute();

    return rows.map((row) => ({
      ...toEntity(row),
      user: {
        id: row.user_id,
        name: row.user_name,
        email: row.user_email,
        image: row.user_image,
      },
    }));
  }

  /**
   * Atomically transition a pending request. The `status = 'pending'` guard
   * makes concurrent approve/deny safe — only the first decision sticks; later
   * ones update 0 rows and return null (already decided).
   */
  async decide(
    id: string,
    status: Exclude<JoinRequestStatus, "pending">,
    decidedBy: string,
  ): Promise<OrganizationJoinRequest | null> {
    const now = new Date().toISOString();
    const res = await this.db
      .updateTable("organization_join_requests")
      .set({
        status,
        decided_by: decidedBy,
        decided_at: now,
        updated_at: now,
      })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .executeTakeFirst();

    if (res.numUpdatedRows === 0n) {
      return null;
    }
    return this.getById(id);
  }
}
