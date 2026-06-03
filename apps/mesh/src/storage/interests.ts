/**
 * Interests storage
 *
 * Per-user "interests" memory, backed by the org-scoped `kv` table.
 * Reads fall back to an org-level doc when a user has none of their own.
 * The curator rewrites the whole list, so the shape is intentionally tiny.
 */

import type { KVStorage } from "./kv";

export interface Interest {
  title: string;
  summary: string;
}

export interface InterestsDoc {
  /** Ordered, most important first. */
  interests: Interest[];
}

const ORG_KEY = "interests:org";
const userKey = (userId: string) => `interests:user:${userId}`;

export interface InterestsStorage {
  /** User doc if present, else the org-level doc, else null. */
  getForUser(orgId: string, userId: string): Promise<InterestsDoc | null>;
  setForUser(orgId: string, userId: string, doc: InterestsDoc): Promise<void>;
  getForOrg(orgId: string): Promise<InterestsDoc | null>;
}

export class KyselyInterestsStorage implements InterestsStorage {
  constructor(private kv: KVStorage) {}

  async getForUser(
    orgId: string,
    userId: string,
  ): Promise<InterestsDoc | null> {
    const own = await this.kv.get(orgId, userKey(userId));
    if (own) return own as unknown as InterestsDoc;
    return this.getForOrg(orgId);
  }

  async setForUser(
    orgId: string,
    userId: string,
    doc: InterestsDoc,
  ): Promise<void> {
    await this.kv.set(
      orgId,
      userKey(userId),
      doc as unknown as Record<string, unknown>,
    );
  }

  async getForOrg(orgId: string): Promise<InterestsDoc | null> {
    const org = await this.kv.get(orgId, ORG_KEY);
    return org ? (org as unknown as InterestsDoc) : null;
  }
}
