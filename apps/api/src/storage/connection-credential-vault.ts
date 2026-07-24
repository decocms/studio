import type { Kysely, Selectable } from "kysely";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import {
  generateWorkloadToken,
  hashWorkloadToken,
  parseWorkloadTokenPrefix,
} from "../vault/workload-token";
import type { Database } from "./types";

export const CREDENTIAL_ACCESS_TOKEN_READ_SCOPE =
  "credential:access-token:read" as const;
export const CREDENTIAL_CONFIGURATION_READ_SCOPE =
  "credential:configuration:read" as const;

type WorkloadTokenRow = Selectable<Database["connection_workload_tokens"]>;

export interface ConnectionWorkloadTokenRecord {
  id: string;
  organizationId: string;
  subjectConnectionId: string;
  tokenHash: string;
  tokenPrefix: string;
  name: string;
  revokedAt: Date | string | null;
  lastUsedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface AuthenticatedWorkloadToken {
  tokenId: string;
  tokenPrefix: string;
  organizationId: string;
  subjectConnectionId: string;
}

export interface CreateOrRotateWorkloadTokenInput {
  organizationId: string;
  subjectConnectionId: string;
  name?: string;
}

export interface FindActiveWorkloadTokenInput {
  organizationId: string;
  subjectConnectionId: string;
  name?: string;
}

export interface RevokeWorkloadTokenInput {
  organizationId: string;
  subjectConnectionId: string;
  tokenId: string;
}

export interface ReplaceCredentialGrantsInput {
  organizationId: string;
  subjectConnectionId: string;
  createdBy: string;
  grants: {
    targetConnectionId: string;
    scope: string;
  }[];
}

export interface HasCredentialGrantInput {
  organizationId: string;
  subjectConnectionId: string;
  targetConnectionId: string;
  scope: string;
}

function toWorkloadTokenRecord(
  row: WorkloadTokenRow,
): ConnectionWorkloadTokenRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    subjectConnectionId: row.subject_connection_id,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    name: row.name,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConnectionCredentialVaultStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async createOrRotateWorkloadToken(
    input: CreateOrRotateWorkloadTokenInput,
  ): Promise<{
    plaintextToken: string;
    record: ConnectionWorkloadTokenRecord;
  }> {
    const name = input.name ?? "default";

    const result = await this.db.transaction().execute(async (trx) => {
      const subject = await trx
        .selectFrom("connections")
        .select("id")
        .where("id", "=", input.subjectConnectionId)
        .where("organization_id", "=", input.organizationId)
        .executeTakeFirst();
      if (!subject) {
        throw new Error("Subject connection not found in organization");
      }

      const token = generateWorkloadToken();
      const now = new Date().toISOString();

      await trx
        .updateTable("connection_workload_tokens")
        .set({
          revoked_at: now,
          updated_at: now,
        })
        .where("organization_id", "=", input.organizationId)
        .where("subject_connection_id", "=", input.subjectConnectionId)
        .where("name", "=", name)
        .where("revoked_at", "is", null)
        .execute();

      const row = await trx
        .insertInto("connection_workload_tokens")
        .values({
          id: generatePrefixedId("cwt"),
          organization_id: input.organizationId,
          subject_connection_id: input.subjectConnectionId,
          token_hash: token.hash,
          token_prefix: token.prefix,
          name,
          revoked_at: null,
          last_used_at: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        plaintextToken: token.plaintext,
        record: toWorkloadTokenRecord(row),
      };
    });

    return result;
  }

  async findActiveWorkloadToken(
    input: FindActiveWorkloadTokenInput,
  ): Promise<ConnectionWorkloadTokenRecord | null> {
    const row = await this.db
      .selectFrom("connection_workload_tokens")
      .selectAll()
      .where("organization_id", "=", input.organizationId)
      .where("subject_connection_id", "=", input.subjectConnectionId)
      .where("name", "=", input.name ?? "default")
      .where("revoked_at", "is", null)
      .executeTakeFirst();

    return row ? toWorkloadTokenRecord(row) : null;
  }

  async revokeWorkloadToken(input: RevokeWorkloadTokenInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .updateTable("connection_workload_tokens")
      .set({
        revoked_at: now,
        updated_at: now,
      })
      .where("id", "=", input.tokenId)
      .where("organization_id", "=", input.organizationId)
      .where("subject_connection_id", "=", input.subjectConnectionId)
      .where("revoked_at", "is", null)
      .execute();
  }

  async authenticateWorkloadToken(
    token: string,
  ): Promise<AuthenticatedWorkloadToken | null> {
    const tokenPrefix = parseWorkloadTokenPrefix(token);
    if (!tokenPrefix) {
      return null;
    }

    const tokenHash = hashWorkloadToken(token);
    const row = await this.db
      .selectFrom("connection_workload_tokens")
      .select([
        "id",
        "organization_id",
        "subject_connection_id",
        "token_prefix",
      ])
      .where("token_prefix", "=", tokenPrefix)
      .where("token_hash", "=", tokenHash)
      .where("revoked_at", "is", null)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    const now = new Date().toISOString();
    await this.db
      .updateTable("connection_workload_tokens")
      .set({
        last_used_at: now,
        updated_at: now,
      })
      .where("id", "=", row.id)
      .execute();

    return {
      tokenId: row.id,
      tokenPrefix: row.token_prefix,
      organizationId: row.organization_id,
      subjectConnectionId: row.subject_connection_id,
    };
  }

  async replaceGrantsForSubject(
    input: ReplaceCredentialGrantsInput,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const subject = await trx
        .selectFrom("connections")
        .select("id")
        .where("id", "=", input.subjectConnectionId)
        .where("organization_id", "=", input.organizationId)
        .executeTakeFirst();
      if (!subject) {
        throw new Error("Referenced connection not found in organization");
      }

      const targetConnectionIds = [
        ...new Set(input.grants.map((grant) => grant.targetConnectionId)),
      ];
      if (targetConnectionIds.length > 0) {
        const targets = await trx
          .selectFrom("connections")
          .select("id")
          .where("organization_id", "=", input.organizationId)
          .where("id", "in", targetConnectionIds)
          .execute();
        if (targets.length !== targetConnectionIds.length) {
          throw new Error("Referenced connection not found in organization");
        }
      }

      await trx
        .deleteFrom("connection_credential_grants")
        .where("organization_id", "=", input.organizationId)
        .where("subject_connection_id", "=", input.subjectConnectionId)
        .execute();

      if (input.grants.length === 0) {
        return;
      }

      const now = new Date().toISOString();
      const rows = input.grants.map((grant) => ({
        id: generatePrefixedId("ccg"),
        organization_id: input.organizationId,
        subject_connection_id: input.subjectConnectionId,
        target_connection_id: grant.targetConnectionId,
        scope: grant.scope,
        created_by: input.createdBy,
        created_at: now,
        updated_at: now,
      }));

      await trx
        .insertInto("connection_credential_grants")
        .values(rows)
        .execute();
    });
  }

  async hasGrant(input: HasCredentialGrantInput): Promise<boolean> {
    const row = await this.db
      .selectFrom("connection_credential_grants")
      .select("id")
      .where("organization_id", "=", input.organizationId)
      .where("subject_connection_id", "=", input.subjectConnectionId)
      .where("target_connection_id", "=", input.targetConnectionId)
      .where("scope", "=", input.scope)
      .executeTakeFirst();

    return !!row;
  }
}
