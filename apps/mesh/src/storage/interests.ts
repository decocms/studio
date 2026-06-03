/**
 * Interests storage
 *
 * Per-(agent, user) "interests" memory, backed by the org-scoped `kv` table.
 * Scoped by agent so each agent keeps its own view — agent A never sees or
 * updates agent B's interests for the same user. The curator/agent rewrites
 * the whole list, so the shape is intentionally tiny.
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

const key = (agentId: string, userId: string) =>
  `interests:${agentId}:${userId}`;

export interface InterestsStorage {
  getForAgent(
    orgId: string,
    agentId: string,
    userId: string,
  ): Promise<InterestsDoc | null>;
  setForAgent(
    orgId: string,
    agentId: string,
    userId: string,
    doc: InterestsDoc,
  ): Promise<void>;
}

export class KyselyInterestsStorage implements InterestsStorage {
  constructor(private kv: KVStorage) {}

  async getForAgent(
    orgId: string,
    agentId: string,
    userId: string,
  ): Promise<InterestsDoc | null> {
    const row = await this.kv.get(orgId, key(agentId, userId));
    return row ? (row as unknown as InterestsDoc) : null;
  }

  async setForAgent(
    orgId: string,
    agentId: string,
    userId: string,
    doc: InterestsDoc,
  ): Promise<void> {
    await this.kv.set(
      orgId,
      key(agentId, userId),
      doc as unknown as Record<string, unknown>,
    );
  }
}
