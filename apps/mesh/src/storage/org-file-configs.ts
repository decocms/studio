import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, FileConfigInfo, OrgFileConfigTable } from "./types";
import { generatePrefixedId } from "@/shared/utils/generate-id";

type FileConfigRow = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  bucket: string;
  region: string;
  endpoint: string | null;
  force_path_style: boolean;
  prefix: string | null;
  created_by: string;
  created_at: Date | string;
  updated_by: string;
  updated_at: Date | string;
};

const PUBLIC_COLUMNS = [
  "id",
  "organization_id",
  "name",
  "description",
  "bucket",
  "region",
  "endpoint",
  "force_path_style",
  "prefix",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
] as const satisfies readonly (keyof OrgFileConfigTable)[];

export interface FileConfigCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

class OrgFileConfigNotFoundError extends Error {
  constructor(identifier: string) {
    super(`File config ${identifier} not found`);
    this.name = "OrgFileConfigNotFoundError";
  }
}

export class OrgFileConfigStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  private rowToInfo(row: FileConfigRow): FileConfigInfo {
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      description: row.description,
      bucket: row.bucket,
      region: row.region,
      endpoint: row.endpoint,
      forcePathStyle: row.force_path_style,
      prefix: row.prefix,
      createdBy: row.created_by,
      createdAt: toIsoString(row.created_at),
      updatedBy: row.updated_by,
      updatedAt: toIsoString(row.updated_at),
    };
  }

  async create(params: {
    organizationId: string;
    name: string;
    description?: string | null;
    bucket: string;
    region: string;
    endpoint?: string | null;
    forcePathStyle?: boolean;
    prefix?: string | null;
    credentials: FileConfigCredentials;
    createdBy: string;
  }): Promise<FileConfigInfo> {
    const id = generatePrefixedId("fcfg");
    const encryptedCredentials = await this.vault.encrypt(
      JSON.stringify(params.credentials),
    );
    const now = new Date();

    const row = await this.db
      .insertInto("org_file_configs")
      .values({
        id,
        organization_id: params.organizationId,
        name: params.name,
        description: params.description ?? null,
        bucket: params.bucket,
        region: params.region,
        endpoint: params.endpoint ?? null,
        force_path_style: params.forcePathStyle ?? false,
        prefix: params.prefix ?? null,
        encrypted_credentials: encryptedCredentials,
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
    name?: string;
    description?: string | null;
    bucket?: string;
    region?: string;
    endpoint?: string | null;
    forcePathStyle?: boolean;
    prefix?: string | null;
    credentials?: FileConfigCredentials;
    updatedBy: string;
  }): Promise<FileConfigInfo> {
    const existing = await this.db
      .selectFrom("org_file_configs")
      .where("id", "=", params.id)
      .where("organization_id", "=", params.organizationId)
      .select(["id"])
      .executeTakeFirst();

    if (!existing) throw new OrgFileConfigNotFoundError(params.id);

    const patch: Partial<{
      name: string;
      description: string | null;
      bucket: string;
      region: string;
      endpoint: string | null;
      force_path_style: boolean;
      prefix: string | null;
      encrypted_credentials: string;
      updated_by: string;
      updated_at: Date;
    }> = {
      updated_by: params.updatedBy,
      updated_at: new Date(),
    };

    if (params.name !== undefined) patch.name = params.name;
    if (params.description !== undefined)
      patch.description = params.description;
    if (params.bucket !== undefined) patch.bucket = params.bucket;
    if (params.region !== undefined) patch.region = params.region;
    if (params.endpoint !== undefined) patch.endpoint = params.endpoint;
    if (params.forcePathStyle !== undefined)
      patch.force_path_style = params.forcePathStyle;
    if (params.prefix !== undefined) patch.prefix = params.prefix;
    if (params.credentials !== undefined) {
      patch.encrypted_credentials = await this.vault.encrypt(
        JSON.stringify(params.credentials),
      );
    }

    const row = await this.db
      .updateTable("org_file_configs")
      .set(patch)
      .where("id", "=", params.id)
      .where("organization_id", "=", params.organizationId)
      .returning(PUBLIC_COLUMNS)
      .executeTakeFirstOrThrow();

    return this.rowToInfo(row);
  }

  async delete(id: string, organizationId: string): Promise<void> {
    const existing = await this.db
      .selectFrom("org_file_configs")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .select(["id"])
      .executeTakeFirst();

    if (!existing) throw new OrgFileConfigNotFoundError(id);

    await this.db
      .deleteFrom("org_file_configs")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  async list(organizationId: string): Promise<FileConfigInfo[]> {
    const rows = await this.db
      .selectFrom("org_file_configs")
      .where("organization_id", "=", organizationId)
      .select(PUBLIC_COLUMNS)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map((row) => this.rowToInfo(row));
  }

  async findById(id: string, organizationId: string): Promise<FileConfigInfo> {
    const row = await this.db
      .selectFrom("org_file_configs")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .select(PUBLIC_COLUMNS)
      .executeTakeFirst();

    if (!row) throw new OrgFileConfigNotFoundError(id);
    return this.rowToInfo(row);
  }

  async resolveById(
    id: string,
    organizationId: string,
  ): Promise<{ info: FileConfigInfo; credentials: FileConfigCredentials }> {
    const row = await this.db
      .selectFrom("org_file_configs")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .selectAll()
      .executeTakeFirst();

    if (!row) throw new OrgFileConfigNotFoundError(id);

    const decrypted = await this.vault.decrypt(row.encrypted_credentials);
    const credentials = JSON.parse(decrypted) as FileConfigCredentials;
    return { info: this.rowToInfo(row), credentials };
  }

  async resolveByName(params: {
    organizationId: string;
    name: string;
  }): Promise<{ info: FileConfigInfo; credentials: FileConfigCredentials }> {
    const row = await this.db
      .selectFrom("org_file_configs")
      .where("organization_id", "=", params.organizationId)
      .where(sql<boolean>`lower(name) = lower(${params.name})`)
      .selectAll()
      .executeTakeFirst();

    if (!row) throw new OrgFileConfigNotFoundError(params.name);

    const decrypted = await this.vault.decrypt(row.encrypted_credentials);
    const credentials = JSON.parse(decrypted) as FileConfigCredentials;
    return { info: this.rowToInfo(row), credentials };
  }
}
