/**
 * Phone preview sessions (QR pairing) and their paired devices.
 *
 * Pairing codes and device tokens are never stored: every lookup goes through
 * the SHA-256 hex of the plaintext. A session belongs to one user of one
 * project; its overlay (`{set, delete}`) is the editor's unsaved edits on top
 * of the branch head, bumped by `rev` on every change.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import type {
  AppPreviewOverlay,
  AppPreviewSessionTable,
  Database,
} from "./types";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_ACTIVE_SESSIONS = 10;
export const MAX_ACTIVE_DEVICES = 5;
export const MAX_OVERLAY_BYTES = 8 * 1024 * 1024;
const LAST_SEEN_THROTTLE_MS = 60_000;

export class OverlayTooLargeError extends Error {
  constructor() {
    super("Preview overlay too large");
    this.name = "OverlayTooLargeError";
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 16 random bytes → 32 lowercase hex characters. */
export function newPairingCode(): string {
  return randomBytes(16).toString("hex");
}

/** `dpv_` + base64url(32 random bytes) — 256 bits. */
export function newDeviceToken(): string {
  return `dpv_${randomBytes(32).toString("base64url")}`;
}

export interface OverlayPatch {
  set?: Record<string, unknown>;
  delete?: string[];
  reset?: boolean;
}

/**
 * `reset` empties the overlay first; `set` writes blocks (un-deleting them);
 * `delete` masks blocks of the base (and drops any pending `set`). Maps, not
 * object assignment, so a `__proto__` key can never touch a prototype.
 */
export function mergeOverlay(
  current: AppPreviewOverlay,
  patch: OverlayPatch,
): AppPreviewOverlay {
  const set = new Map(patch.reset ? [] : Object.entries(current.set));
  const deleted = new Set(patch.reset ? [] : current.delete);
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    set.set(key, value);
    deleted.delete(key);
  }
  for (const key of patch.delete ?? []) {
    set.delete(key);
    deleted.add(key);
  }
  return { set: Object.fromEntries(set), delete: [...deleted] };
}

export interface PreviewOwner {
  organizationId: string;
  virtualMcpId: string;
  userId: string;
}

export interface AppPreviewSession {
  id: string;
  organizationId: string;
  virtualMcpId: string;
  userId: string;
  branch: string;
  overlay: AppPreviewOverlay;
  rev: number;
  pairingExpiresAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AppPreviewDevice {
  id: string;
  createdAt: string;
  lastSeenAt: string;
}

type SessionRow = {
  id: string;
  organization_id: string;
  virtual_mcp_id: string;
  user_id: string;
  branch: string;
  overlay: AppPreviewOverlay;
  rev: number;
  pairing_expires_at: Date | string | null;
  expires_at: Date | string;
  revoked_at: Date | string | null;
};

const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v === null ? null : iso(v));

function toSession(row: SessionRow): AppPreviewSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    virtualMcpId: row.virtual_mcp_id,
    userId: row.user_id,
    branch: row.branch,
    overlay: row.overlay,
    rev: row.rev,
    pairingExpiresAt: isoOrNull(row.pairing_expires_at),
    expiresAt: iso(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

type SessionEb = ExpressionBuilder<
  Database & { s: AppPreviewSessionTable },
  "s"
>;

/** The session creator must still be a member of the session's org. */
function creatorIsMember(eb: SessionEb) {
  return eb.exists(
    eb
      .selectFrom("member")
      .select(sql`1`.as("one"))
      .whereRef("member.userId", "=", "s.user_id")
      .whereRef("member.organizationId", "=", "s.organization_id"),
  );
}

export class AppPreviewSessionStorage {
  constructor(private db: Kysely<Database>) {}

  /** New session with a fresh pairing code; revokes the owner's oldest active
   *  sessions beyond {@link MAX_ACTIVE_SESSIONS} (`revokedIds`, so the caller
   *  can end their open streams). */
  async create(
    owner: PreviewOwner & { branch: string; pairingCode: string },
    now = new Date(),
  ): Promise<AppPreviewSession & { revokedIds: string[] }> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("app_preview_sessions")
        .values({
          id: `aps_${randomUUID()}`,
          organization_id: owner.organizationId,
          virtual_mcp_id: owner.virtualMcpId,
          user_id: owner.userId,
          branch: owner.branch,
          pairing_code_hash: sha256Hex(owner.pairingCode),
          pairing_expires_at: new Date(now.getTime() + PAIRING_TTL_MS),
          expires_at: new Date(now.getTime() + SESSION_TTL_MS),
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const beyondCap = trx
        .selectFrom("app_preview_sessions")
        .select("id")
        .where("organization_id", "=", owner.organizationId)
        .where("virtual_mcp_id", "=", owner.virtualMcpId)
        .where("user_id", "=", owner.userId)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", now)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .offset(MAX_ACTIVE_SESSIONS);
      const revoked = await trx
        .updateTable("app_preview_sessions")
        .set({ revoked_at: now, pairing_code_hash: null, updated_at: now })
        .where("id", "in", beyondCap)
        .returning("id")
        .execute();

      return { ...toSession(row), revokedIds: revoked.map((r) => r.id) };
    });
  }

  /** New pairing code for an active session; the previous code dies. */
  async rotatePairing(
    id: string,
    owner: PreviewOwner,
    pairingCode: string,
    now = new Date(),
  ): Promise<AppPreviewSession | null> {
    const row = await this.db
      .updateTable("app_preview_sessions")
      .set({
        pairing_code_hash: sha256Hex(pairingCode),
        pairing_expires_at: new Date(now.getTime() + PAIRING_TTL_MS),
        updated_at: now,
      })
      .where("id", "=", id)
      .where("organization_id", "=", owner.organizationId)
      .where("virtual_mcp_id", "=", owner.virtualMcpId)
      .where("user_id", "=", owner.userId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", now)
      .returningAll()
      .executeTakeFirst();
    return row ? toSession(row) : null;
  }

  /** The session (revoked/expired included) and its active devices. */
  async getForOwner(
    id: string,
    owner: PreviewOwner,
  ): Promise<{
    session: AppPreviewSession;
    devices: AppPreviewDevice[];
  } | null> {
    const row = await this.db
      .selectFrom("app_preview_sessions")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", owner.organizationId)
      .where("virtual_mcp_id", "=", owner.virtualMcpId)
      .where("user_id", "=", owner.userId)
      .executeTakeFirst();
    if (!row) return null;
    const devices = await this.db
      .selectFrom("app_preview_devices")
      .select(["id", "created_at", "last_seen_at"])
      .where("session_id", "=", id)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "asc")
      .execute();
    return {
      session: toSession(row),
      devices: devices.map((d) => ({
        id: d.id,
        createdAt: iso(d.created_at),
        lastSeenAt: iso(d.last_seen_at),
      })),
    };
  }

  /** Merges `patch` into an active session's overlay and bumps `rev`.
   *  Null when there is no such active session; throws
   *  {@link OverlayTooLargeError} past {@link MAX_OVERLAY_BYTES}. */
  async patchOverlay(
    id: string,
    owner: PreviewOwner,
    patch: OverlayPatch,
    now = new Date(),
  ): Promise<{ rev: number } | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("app_preview_sessions")
        .select(["overlay", "rev"])
        .where("id", "=", id)
        .where("organization_id", "=", owner.organizationId)
        .where("virtual_mcp_id", "=", owner.virtualMcpId)
        .where("user_id", "=", owner.userId)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", now)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return null;
      const json = JSON.stringify(mergeOverlay(row.overlay, patch));
      if (Buffer.byteLength(json) > MAX_OVERLAY_BYTES) {
        throw new OverlayTooLargeError();
      }
      const rev = row.rev + 1;
      await trx
        .updateTable("app_preview_sessions")
        .set({ overlay: json, rev, updated_at: now })
        .where("id", "=", id)
        .execute();
      return { rev };
    });
  }

  /** Revokes the session and its devices. False when the owner has no such
   *  session; revoking twice is not an error. */
  async revoke(
    id: string,
    owner: PreviewOwner,
    now = new Date(),
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("app_preview_sessions")
        .set({
          revoked_at: sql<Date>`coalesce(revoked_at, ${now})`,
          pairing_code_hash: null,
          updated_at: now,
        })
        .where("id", "=", id)
        .where("organization_id", "=", owner.organizationId)
        .where("virtual_mcp_id", "=", owner.virtualMcpId)
        .where("user_id", "=", owner.userId)
        .returning("id")
        .executeTakeFirst();
      if (!row) return false;
      await trx
        .updateTable("app_preview_devices")
        .set({ revoked_at: now })
        .where("session_id", "=", id)
        .where("revoked_at", "is", null)
        .execute();
      return true;
    });
  }

  /**
   * Burns a pairing code (single use, even when the device cap then refuses)
   * and pairs a device holding `token`. Null on any failure — unknown, used or
   * expired code, revoked/expired session, other org, creator no longer a
   * member, or {@link MAX_ACTIVE_DEVICES} already paired.
   */
  async claim(
    pairingCode: string,
    organizationId: string,
    token: string,
    now = new Date(),
  ): Promise<(AppPreviewSession & { deviceId: string }) | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("app_preview_sessions as s")
        .set({
          pairing_code_hash: null,
          pairing_expires_at: null,
          updated_at: now,
        })
        .where("s.pairing_code_hash", "=", sha256Hex(pairingCode))
        .where("s.organization_id", "=", organizationId)
        .where("s.pairing_expires_at", ">", now)
        .where("s.revoked_at", "is", null)
        .where("s.expires_at", ">", now)
        .where((eb) => creatorIsMember(eb as unknown as SessionEb))
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;

      const { count } = await trx
        .selectFrom("app_preview_devices")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("session_id", "=", row.id)
        .where("revoked_at", "is", null)
        .executeTakeFirstOrThrow();
      if (Number(count) >= MAX_ACTIVE_DEVICES) return null;

      const deviceId = `apd_${randomUUID()}`;
      await trx
        .insertInto("app_preview_devices")
        .values({
          id: deviceId,
          session_id: row.id,
          token_hash: sha256Hex(token),
          created_at: now,
          last_seen_at: now,
        })
        .execute();
      return { ...toSession(row), deviceId };
    });
  }

  /** Session + device for a device token, or null when the token, device or
   *  session is unknown, revoked or expired, the org differs, or the creator
   *  left the org. Bumps `last_seen_at` at most once per minute. */
  async authenticateDevice(
    token: string,
    organizationId: string,
    now = new Date(),
  ): Promise<{ session: AppPreviewSession; deviceId: string } | null> {
    const row = await this.db
      .selectFrom("app_preview_devices as d")
      .innerJoin("app_preview_sessions as s", "s.id", "d.session_id")
      .selectAll("s")
      .select(["d.id as device_id", "d.last_seen_at as device_last_seen_at"])
      .where("d.token_hash", "=", sha256Hex(token))
      .where("d.revoked_at", "is", null)
      .where("s.revoked_at", "is", null)
      .where("s.expires_at", ">", now)
      .where("s.organization_id", "=", organizationId)
      .where((eb) => creatorIsMember(eb as unknown as SessionEb))
      .executeTakeFirst();
    if (!row) return null;

    const staleBefore = new Date(now.getTime() - LAST_SEEN_THROTTLE_MS);
    if (new Date(row.device_last_seen_at) < staleBefore) {
      await this.db
        .updateTable("app_preview_devices")
        .set({ last_seen_at: now })
        .where("id", "=", row.device_id)
        .where("last_seen_at", "<", staleBefore)
        .execute();
    }
    return { session: toSession(row), deviceId: row.device_id };
  }

  /** Revokes one device (its token stops working). */
  async revokeDevice(deviceId: string, now = new Date()): Promise<void> {
    await this.db
      .updateTable("app_preview_devices")
      .set({ revoked_at: now })
      .where("id", "=", deviceId)
      .where("revoked_at", "is", null)
      .execute();
  }

  /** Deletes sessions (devices cascade) expired or revoked before
   *  `olderThan`, and devices revoked before it. */
  async deleteExpired(olderThan: Date): Promise<void> {
    await this.db
      .deleteFrom("app_preview_sessions")
      .where((eb) =>
        eb.or([
          eb("expires_at", "<", olderThan),
          eb("revoked_at", "<", olderThan),
        ]),
      )
      .execute();
    await this.db
      .deleteFrom("app_preview_devices")
      .where("revoked_at", "<", olderThan)
      .execute();
  }
}
