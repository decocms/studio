import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, FileConfigInfo, OrgFileConfigTable } from "./types";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";

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
  public_url_base: string | null;
  credential_type: "static" | "sts-session" | "managed";
  refresh_url: string | null;
  site_slug: string | null;
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
  "public_url_base",
  "credential_type",
  "refresh_url",
  "site_slug",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
] as const satisfies readonly (keyof OrgFileConfigTable)[];

/**
 * Credentials persisted (encrypted) for a file config.
 *
 * - `static`: a long-lived S3 key pair, used verbatim.
 * - `sts-session`: only the API key needed to authenticate the refresh call —
 *   no S3 secret is stored. The actual temporary credentials are fetched on
 *   demand from the config's `refreshUrl` and refreshed automatically.
 * - `managed`: no secret at all. Studio mints prefix-scoped STS credentials
 *   in-process for the config's `siteSlug` (see `tenant-credentials.ts`),
 *   authorized by `org_sites` ownership. A sentinel blob is stored to satisfy
 *   the NOT NULL `encrypted_credentials` column.
 */
export type FileConfigCredentials =
  | { type: "static"; accessKeyId: string; secretAccessKey: string }
  | { type: "sts-session"; apiKey: string }
  | { type: "managed" };

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
      publicUrlBase: row.public_url_base,
      credentialType: row.credential_type ?? "static",
      refreshUrl: row.refresh_url,
      siteSlug: row.site_slug,
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
    publicUrlBase?: string | null;
    refreshUrl?: string | null;
    siteSlug?: string | null;
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
        public_url_base: params.publicUrlBase ?? null,
        credential_type: params.credentials.type,
        refresh_url: params.refreshUrl ?? null,
        site_slug: params.siteSlug ?? null,
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
    publicUrlBase?: string | null;
    refreshUrl?: string | null;
    siteSlug?: string | null;
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
      public_url_base: string | null;
      credential_type: "static" | "sts-session" | "managed";
      refresh_url: string | null;
      site_slug: string | null;
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
    if (params.publicUrlBase !== undefined)
      patch.public_url_base = params.publicUrlBase;
    if (params.refreshUrl !== undefined) patch.refresh_url = params.refreshUrl;
    if (params.siteSlug !== undefined) patch.site_slug = params.siteSlug;
    if (params.credentials !== undefined) {
      patch.credential_type = params.credentials.type;
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

    return {
      info: this.rowToInfo(row),
      credentials: await this.decodeCredentials(row),
    };
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

    return {
      info: this.rowToInfo(row),
      credentials: await this.decodeCredentials(row),
    };
  }

  /**
   * Decrypt and shape the stored credentials according to the row's
   * `credential_type` column (the source of truth). Legacy rows predate the
   * column — they default to `static` and their blob holds the key pair
   * directly, with no `type` field — so we never rely on the blob's shape.
   */
  private async decodeCredentials(row: {
    credential_type: "static" | "sts-session" | "managed";
    encrypted_credentials: string;
  }): Promise<FileConfigCredentials> {
    // `managed` rows hold no secret — the stored blob is a sentinel; studio
    // mints credentials in-process. Short-circuit before touching the vault.
    if (row.credential_type === "managed") {
      return { type: "managed" };
    }
    const decrypted = await this.vault.decrypt(row.encrypted_credentials);
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;
    if ((row.credential_type ?? "static") === "sts-session") {
      return { type: "sts-session", apiKey: String(parsed.apiKey) };
    }
    return {
      type: "static",
      accessKeyId: String(parsed.accessKeyId),
      secretAccessKey: String(parsed.secretAccessKey),
    };
  }
}
