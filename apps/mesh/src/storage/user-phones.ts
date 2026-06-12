import type { Kysely } from "kysely";
import type { Database } from "./types";
import { generatePrefixedId } from "@/shared/utils/generate-id";

export type PhoneLinkStatus = "none" | "pending" | "verified";

export interface UserPhoneLink {
  userId: string;
  phone: string | null;
  status: PhoneLinkStatus;
  /** Pending verification code (only while not yet verified). */
  code: string | null;
  selectedOrganizationId: string | null;
}

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Storage for the WhatsApp concierge phone links. Verification is inbound-only:
 * `issueCode` stores a pending code (no phone yet); the matching inbound message
 * is resolved via `findPendingByCode`, and `bindVerified` stamps the sender's
 * number once ownership is proven.
 */
export class UserPhoneStorage {
  constructor(private db: Kysely<Database>) {}

  /** Issue/refresh a pending verification code for a user (upsert by user_id). */
  async issueCode(userId: string, code: string, ttlMs: number): Promise<void> {
    const expires = new Date(Date.now() + ttlMs).toISOString();
    await this.db
      .insertInto("user_phones")
      .values({
        id: generatePrefixedId("uph"),
        user_id: userId,
        phone: null,
        verified_at: null,
        code,
        code_expires_at: expires,
        selected_organization_id: null,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          code,
          code_expires_at: expires,
        }),
      )
      .execute();
  }

  /** Resolve a non-expired pending code to its owning user. */
  async findPendingByCode(code: string): Promise<{ userId: string } | null> {
    const row = await this.db
      .selectFrom("user_phones")
      .select(["user_id", "code_expires_at"])
      .where("code", "=", code)
      .executeTakeFirst();
    if (!row) return null;
    const exp = toIso(row.code_expires_at ?? null);
    if (exp && new Date(exp).getTime() < Date.now()) return null;
    return { userId: row.user_id };
  }

  /**
   * Bind a verified phone to the user (clears the pending code). Returns
   * `{ ok: false, reason: "taken" }` if the phone is already verified to a
   * different user.
   */
  async bindVerified(
    userId: string,
    phone: string,
  ): Promise<{ ok: true } | { ok: false; reason: "taken" }> {
    const owner = await this.db
      .selectFrom("user_phones")
      .select(["user_id"])
      .where("phone", "=", phone)
      .where("verified_at", "is not", null)
      .executeTakeFirst();
    if (owner && owner.user_id !== userId) {
      return { ok: false, reason: "taken" };
    }
    await this.db
      .updateTable("user_phones")
      .set({
        phone,
        verified_at: new Date().toISOString(),
        code: null,
        code_expires_at: null,
      })
      .where("user_id", "=", userId)
      .execute();
    return { ok: true };
  }

  async getByUser(userId: string): Promise<UserPhoneLink | null> {
    const row = await this.db
      .selectFrom("user_phones")
      .select([
        "user_id",
        "phone",
        "verified_at",
        "code",
        "selected_organization_id",
      ])
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      userId: row.user_id,
      phone: row.phone,
      status: row.verified_at ? "verified" : "pending",
      code: row.verified_at ? null : row.code,
      selectedOrganizationId: row.selected_organization_id,
    };
  }

  /** Resolve a verified phone to its user (inbound routing key). */
  async findVerifiedByPhone(
    phone: string,
  ): Promise<{ userId: string; selectedOrganizationId: string | null } | null> {
    const row = await this.db
      .selectFrom("user_phones")
      .select(["user_id", "selected_organization_id"])
      .where("phone", "=", phone)
      .where("verified_at", "is not", null)
      .executeTakeFirst();
    if (!row) return null;
    return {
      userId: row.user_id,
      selectedOrganizationId: row.selected_organization_id,
    };
  }

  async setSelectedOrg(
    userId: string,
    organizationId: string | null,
  ): Promise<void> {
    await this.db
      .updateTable("user_phones")
      .set({ selected_organization_id: organizationId })
      .where("user_id", "=", userId)
      .execute();
  }

  async delete(userId: string): Promise<void> {
    await this.db
      .deleteFrom("user_phones")
      .where("user_id", "=", userId)
      .execute();
  }
}
