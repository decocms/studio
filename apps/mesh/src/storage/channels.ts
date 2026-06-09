import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type {
  ChannelInfo,
  ChannelStatus,
  ChannelType,
  Database,
} from "./types";
import { generatePrefixedId } from "@/shared/utils/generate-id";

/**
 * Per-platform secret credentials, stored vault-encrypted as a single JSON
 * blob in `channels.encrypted_credentials`. The shape is platform-specific;
 * the channel adapters validate it against their `credentialSchema`.
 */
export type ChannelCredentials = Record<string, unknown>;

interface ChannelRow {
  id: string;
  organization_id: string;
  channel_type: string;
  label: string;
  agent_id: string | null;
  bot_user_id: string;
  metadata: string | null;
  status: string;
  created_by: string;
  created_at: Date | string;
}

/**
 * Org-scoped storage for chat-channel integrations. Mirrors
 * `AIProviderKeyStorage`: secrets are vault-encrypted at rest into a single
 * opaque blob and only decrypted on `resolve()` (request-scoped, never cached
 * in plaintext). The public `ChannelInfo` DTO never carries the blob.
 */
export class ChannelStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  private rowToInfo(row: ChannelRow): ChannelInfo {
    return {
      id: row.id,
      channelType: row.channel_type as ChannelType,
      label: row.label,
      agentId: row.agent_id,
      botUserId: row.bot_user_id,
      metadata: row.metadata
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : null,
      status: row.status as ChannelStatus,
      organizationId: row.organization_id,
      createdBy: row.created_by,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    };
  }

  private readonly SELECT = [
    "id",
    "organization_id",
    "channel_type",
    "label",
    "agent_id",
    "bot_user_id",
    "metadata",
    "status",
    "created_by",
    "created_at",
  ] as const;

  async create(params: {
    id?: string;
    channelType: ChannelType;
    label: string;
    botUserId: string;
    agentId?: string | null;
    credentials?: ChannelCredentials | null;
    metadata?: Record<string, unknown> | null;
    status?: ChannelStatus;
    organizationId: string;
    createdBy: string;
  }): Promise<ChannelInfo> {
    const id = params.id ?? generatePrefixedId("chan");
    const createdAt = new Date();
    const encrypted = params.credentials
      ? await this.vault.encrypt(JSON.stringify(params.credentials))
      : null;

    const row = await this.db
      .insertInto("channels")
      .values({
        id,
        organization_id: params.organizationId,
        channel_type: params.channelType,
        label: params.label,
        encrypted_credentials: encrypted,
        agent_id: params.agentId ?? null,
        bot_user_id: params.botUserId,
        metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        status: params.status ?? "draft",
        created_by: params.createdBy,
        created_at: createdAt,
      })
      .returning(this.SELECT)
      .executeTakeFirstOrThrow();

    return this.rowToInfo(row);
  }

  async list(params: {
    organizationId: string;
    channelType?: ChannelType;
  }): Promise<ChannelInfo[]> {
    let query = this.db
      .selectFrom("channels")
      .where("organization_id", "=", params.organizationId)
      .select(this.SELECT);

    if (params.channelType) {
      query = query.where("channel_type", "=", params.channelType);
    }

    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map((row) => this.rowToInfo(row));
  }

  async findById(
    id: string,
    organizationId: string,
  ): Promise<ChannelInfo | null> {
    const row = await this.db
      .selectFrom("channels")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .select(this.SELECT)
      .executeTakeFirst();
    return row ? this.rowToInfo(row) : null;
  }

  /**
   * Decrypt and return the channel's credentials alongside its metadata. Only
   * call when you need to verify a signature or talk to the platform API —
   * the plaintext is request-scoped and never cached.
   */
  async resolve(
    id: string,
    organizationId: string,
  ): Promise<{ info: ChannelInfo; credentials: ChannelCredentials | null }> {
    const row = await this.db
      .selectFrom("channels")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .selectAll()
      .executeTakeFirst();
    if (!row) {
      throw new Error(`Channel ${id} not found`);
    }
    const credentials = row.encrypted_credentials
      ? (JSON.parse(
          await this.vault.decrypt(row.encrypted_credentials),
        ) as ChannelCredentials)
      : null;
    return { info: this.rowToInfo(row), credentials };
  }

  async update(
    id: string,
    organizationId: string,
    updates: {
      label?: string;
      agentId?: string | null;
      credentials?: ChannelCredentials;
      metadata?: Record<string, unknown> | null;
      status?: ChannelStatus;
    },
  ): Promise<ChannelInfo> {
    const set: Record<string, unknown> = {};
    if (updates.label !== undefined) set.label = updates.label;
    if (updates.agentId !== undefined) set.agent_id = updates.agentId;
    if (updates.status !== undefined) set.status = updates.status;
    if (updates.metadata !== undefined) {
      set.metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;
    }
    if (updates.credentials !== undefined) {
      set.encrypted_credentials = await this.vault.encrypt(
        JSON.stringify(updates.credentials),
      );
    }

    if (Object.keys(set).length === 0) {
      const existing = await this.findById(id, organizationId);
      if (!existing) throw new Error(`Channel ${id} not found`);
      return existing;
    }

    const row = await this.db
      .updateTable("channels")
      .set(set)
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .returning(this.SELECT)
      .executeTakeFirst();
    if (!row) throw new Error(`Channel ${id} not found`);
    return this.rowToInfo(row);
  }

  async delete(id: string, organizationId: string): Promise<void> {
    const result = await this.db
      .deleteFrom("channels")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    if (!result.numDeletedRows) {
      throw new Error(`Channel ${id} not found`);
    }
  }
}
