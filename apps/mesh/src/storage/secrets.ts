import { type Kysely, sql } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type {
  Database,
  SecretInfo,
  SecretScopeKind,
  SecretTable,
} from "./types";
import { generatePrefixedId } from "@/shared/utils/generate-id";

export type SecretScope =
  | { kind: "user"; userId: string }
  | { kind: "organization" };

type SecretRow = {
  id: string;
  organization_id: string;
  scope: SecretScopeKind;
  user_id: string | null;
  name: string;
  description: string | null;
  created_by: string;
  created_at: Date | string;
  updated_by: string;
  updated_at: Date | string;
};

const PUBLIC_COLUMNS = [
  "id",
  "organization_id",
  "scope",
  "user_id",
  "name",
  "description",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
] as const satisfies readonly (keyof SecretTable)[];

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export class SecretNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Secret ${identifier} not found`);
    this.name = "SecretNotFoundError";
  }
}

export class SecretAccessDeniedError extends Error {
  constructor(id: string) {
    super(`Access denied for secret ${id}`);
    this.name = "SecretAccessDeniedError";
  }
}

export class SecretStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  private rowToInfo(row: SecretRow): SecretInfo {
    return {
      id: row.id,
      organizationId: row.organization_id,
      scope: row.scope,
      userId: row.user_id,
      name: row.name,
      description: row.description,
      createdBy: row.created_by,
      createdAt: toIsoString(row.created_at),
      updatedBy: row.updated_by,
      updatedAt: toIsoString(row.updated_at),
    };
  }

  // Org-scoped rows are gated by ctx.access.check() at the tool layer; storage only blocks cross-user reads of `user`-scoped rows.
  private assertVisible(
    row: { scope: SecretScopeKind; user_id: string | null; id: string },
    callerUserId: string,
  ) {
    if (row.scope === "user" && row.user_id !== callerUserId) {
      throw new SecretAccessDeniedError(row.id);
    }
  }

  async create(params: {
    organizationId: string;
    scope: SecretScope;
    name: string;
    value: string;
    description?: string | null;
    createdBy: string;
  }): Promise<SecretInfo> {
    const id = generatePrefixedId("sec");
    const encryptedValue = await this.vault.encrypt(params.value);
    const now = new Date();

    const row = await this.db
      .insertInto("secrets")
      .values({
        id,
        organization_id: params.organizationId,
        scope: params.scope.kind,
        user_id: params.scope.kind === "user" ? params.scope.userId : null,
        name: params.name,
        encrypted_value: encryptedValue,
        description: params.description ?? null,
        created_by: params.createdBy,
        created_at: now,
        updated_by: params.createdBy,
        updated_at: now,
      })
      .returning(PUBLIC_COLUMNS)
      .executeTakeFirstOrThrow();

    return this.rowToInfo(row);
  }

  async update(params: {
    id: string;
    organizationId: string;
    callerUserId: string;
    value?: string;
    description?: string | null;
    updatedBy: string;
  }): Promise<SecretInfo> {
    const existing = await this.db
      .selectFrom("secrets")
      .where("id", "=", params.id)
      .where("organization_id", "=", params.organizationId)
      .select(["id", "scope", "user_id"])
      .executeTakeFirst();

    if (!existing) throw new SecretNotFoundError(params.id);
    this.assertVisible(existing, params.callerUserId);

    const patch: Partial<{
      encrypted_value: string;
      description: string | null;
      updated_by: string;
      updated_at: Date;
    }> = {
      updated_by: params.updatedBy,
      updated_at: new Date(),
    };

    if (params.value !== undefined) {
      patch.encrypted_value = await this.vault.encrypt(params.value);
    }
    if (params.description !== undefined) {
      patch.description = params.description;
    }

    const row = await this.db
      .updateTable("secrets")
      .set(patch)
      .where("id", "=", params.id)
      .where("organization_id", "=", params.organizationId)
      .returning(PUBLIC_COLUMNS)
      .executeTakeFirstOrThrow();

    return this.rowToInfo(row);
  }

  async delete(
    id: string,
    organizationId: string,
    callerUserId: string,
  ): Promise<void> {
    const existing = await this.db
      .selectFrom("secrets")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .select(["id", "scope", "user_id"])
      .executeTakeFirst();

    if (!existing) throw new SecretNotFoundError(id);
    this.assertVisible(existing, callerUserId);

    await this.db
      .deleteFrom("secrets")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  async list(params: {
    organizationId: string;
    callerUserId: string;
    scope?: SecretScope;
  }): Promise<SecretInfo[]> {
    let query = this.db
      .selectFrom("secrets")
      .where("organization_id", "=", params.organizationId)
      .select(PUBLIC_COLUMNS);

    if (params.scope?.kind === "user") {
      query = query
        .where("scope", "=", "user")
        .where("user_id", "=", params.scope.userId);
    } else if (params.scope?.kind === "organization") {
      query = query.where("scope", "=", "organization");
    } else {
      query = query.where((eb) =>
        eb.or([
          eb("scope", "=", "organization"),
          eb.and([
            eb("scope", "=", "user"),
            eb("user_id", "=", params.callerUserId),
          ]),
        ]),
      );
    }

    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map((row) => this.rowToInfo(row));
  }

  async findById(
    id: string,
    organizationId: string,
    callerUserId: string,
  ): Promise<SecretInfo> {
    const row = await this.db
      .selectFrom("secrets")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .select(PUBLIC_COLUMNS)
      .executeTakeFirst();

    if (!row) throw new SecretNotFoundError(id);
    this.assertVisible(row, callerUserId);
    return this.rowToInfo(row);
  }

  async resolveById(
    id: string,
    organizationId: string,
    callerUserId: string,
  ): Promise<{ info: SecretInfo; value: string }> {
    const row = await this.db
      .selectFrom("secrets")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .selectAll()
      .executeTakeFirst();

    if (!row) throw new SecretNotFoundError(id);
    this.assertVisible(row, callerUserId);

    const value = await this.vault.decrypt(row.encrypted_value);
    return { info: this.rowToInfo(row), value };
  }

  async resolveByName(params: {
    organizationId: string;
    scope: SecretScope;
    name: string;
  }): Promise<{ info: SecretInfo; value: string }> {
    let query = this.db
      .selectFrom("secrets")
      .where("organization_id", "=", params.organizationId)
      .where("scope", "=", params.scope.kind)
      .where(sql<boolean>`lower(name) = lower(${params.name})`)
      .selectAll();

    if (params.scope.kind === "user") {
      query = query.where("user_id", "=", params.scope.userId);
    }

    const row = await query.executeTakeFirst();
    if (!row)
      throw new SecretNotFoundError(`${params.scope.kind}:${params.name}`);

    const value = await this.vault.decrypt(row.encrypted_value);
    return { info: this.rowToInfo(row), value };
  }
}
