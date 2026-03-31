import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import type {
  PrivateRegistryDatabase,
  PublishRequestCreateInput,
  PublishRequestEntity,
  PublishRequestStatus,
  RegistryServerDefinition,
  RegistryItemMeta,
} from "./types";

type RawRow = Selectable<
  PrivateRegistryDatabase["private_registry_publish_request"]
>;

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class PublishRequestStorage {
  constructor(private db: Kysely<PrivateRegistryDatabase>) {}

  /**
   * Create a new publish request, or update an existing pending request with
   * the same `requested_id` (upsert behaviour — avoids duplicates).
   */
  async createOrUpdate(
    input: PublishRequestCreateInput,
  ): Promise<PublishRequestEntity> {
    const now = new Date().toISOString();

    // Check for an existing pending request with the same requested_id
    const existing = await this.findPendingByRequestedId(
      input.organization_id,
      input.requested_id,
    );

    if (existing) {
      // Update the existing pending request with new data
      const update: Updateable<
        PrivateRegistryDatabase["private_registry_publish_request"]
      > = {
        title: input.title,
        description: input.description ?? null,
        server_json: JSON.stringify(input.server),
        meta_json: input._meta ? JSON.stringify(input._meta) : null,
        requester_name: input.requester_name ?? null,
        requester_email: input.requester_email ?? null,
        updated_at: now,
      };

      await this.db
        .updateTable("private_registry_publish_request")
        .set(update)
        .where("organization_id", "=", input.organization_id)
        .where("id", "=", existing.id)
        .execute();

      const updated = await this.findById(input.organization_id, existing.id);
      if (!updated) {
        throw new Error("Failed to update publish request");
      }
      return updated;
    }

    // Create new request
    const id = randomUUID();
    const row: Insertable<
      PrivateRegistryDatabase["private_registry_publish_request"]
    > = {
      id,
      organization_id: input.organization_id,
      requested_id: input.requested_id,
      status: "pending",
      title: input.title,
      description: input.description ?? null,
      server_json: JSON.stringify(input.server),
      meta_json: input._meta ? JSON.stringify(input._meta) : null,
      requester_name: input.requester_name ?? null,
      requester_email: input.requester_email ?? null,
      reviewer_notes: null,
      created_at: now,
      updated_at: now,
    };

    await this.db
      .insertInto("private_registry_publish_request")
      .values(row)
      .execute();
    const created = await this.findById(input.organization_id, id);
    if (!created) {
      throw new Error("Failed to create publish request");
    }
    return created;
  }

  /**
   * Find a pending publish request by its requested registry item ID.
   */
  async findPendingByRequestedId(
    organizationId: string,
    requestedId: string,
  ): Promise<PublishRequestEntity | null> {
    const row = await this.db
      .selectFrom("private_registry_publish_request")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("requested_id", "=", requestedId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return row ? this.deserialize(row as RawRow) : null;
  }

  async findById(
    organizationId: string,
    id: string,
  ): Promise<PublishRequestEntity | null> {
    const row = await this.db
      .selectFrom("private_registry_publish_request")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.deserialize(row as RawRow) : null;
  }

  async list(
    organizationId: string,
    query: {
      status?: PublishRequestStatus;
      limit?: number;
      offset?: number;
      sortBy?: "created_at" | "title";
      sortDirection?: "asc" | "desc";
    } = {},
  ): Promise<{ items: PublishRequestEntity[]; totalCount: number }> {
    let listQuery = this.db
      .selectFrom("private_registry_publish_request")
      .selectAll()
      .where("organization_id", "=", organizationId);

    let countQuery = this.db
      .selectFrom("private_registry_publish_request")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("organization_id", "=", organizationId);

    if (query.status) {
      listQuery = listQuery.where("status", "=", query.status);
      countQuery = countQuery.where("status", "=", query.status);
    }

    const totalCountRow = await countQuery.executeTakeFirst();
    const totalCount = Number(totalCountRow?.count ?? 0);

    const sortBy = query.sortBy ?? "created_at";
    const sortDirection = query.sortDirection ?? "desc";
    if (sortBy === "title") {
      listQuery = listQuery.orderBy("title", sortDirection);
    } else {
      listQuery = listQuery.orderBy("created_at", sortDirection);
    }

    const rows = await listQuery
      .limit(query.limit ?? 24)
      .offset(query.offset ?? 0)
      .execute();

    return {
      items: rows.map((row) => this.deserialize(row as RawRow)),
      totalCount,
    };
  }

  async updateStatus(
    organizationId: string,
    id: string,
    status: PublishRequestStatus,
    reviewerNotes?: string | null,
  ): Promise<PublishRequestEntity> {
    const update: Updateable<
      PrivateRegistryDatabase["private_registry_publish_request"]
    > = {
      status,
      updated_at: new Date().toISOString(),
      reviewer_notes: reviewerNotes ?? null,
    };

    await this.db
      .updateTable("private_registry_publish_request")
      .set(update)
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .execute();

    const updated = await this.findById(organizationId, id);
    if (!updated) {
      throw new Error(`Publish request not found: ${id}`);
    }
    return updated;
  }

  async countPending(organizationId: string): Promise<number> {
    const row = await this.db
      .selectFrom("private_registry_publish_request")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("organization_id", "=", organizationId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async delete(
    organizationId: string,
    id: string,
  ): Promise<PublishRequestEntity | null> {
    const existing = await this.findById(organizationId, id);
    if (!existing) return null;
    await this.db
      .deleteFrom("private_registry_publish_request")
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .execute();
    return existing;
  }

  private deserialize(row: RawRow): PublishRequestEntity {
    return {
      id: row.id,
      organization_id: row.organization_id,
      requested_id: row.requested_id ?? null,
      status: row.status,
      title: row.title,
      description: row.description,
      _meta: safeJsonParse<RegistryItemMeta>(row.meta_json, {}),
      server: safeJsonParse<RegistryServerDefinition>(row.server_json, {
        name: "",
      }),
      requester_name: row.requester_name,
      requester_email: row.requester_email,
      reviewer_notes: row.reviewer_notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
