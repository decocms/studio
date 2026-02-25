/**
 * Diagnostic Session Storage
 *
 * CRUD operations for diagnostic sessions. Sessions are pre-auth —
 * organization_id and project_id start as null and are associated
 * retroactively after the user logs in (Phase 21).
 *
 * JSON columns (agents, results) are serialized/deserialized transparently.
 */

import type { Kysely } from "kysely";
import type {
  AgentStatus,
  DiagnosticAgentId,
  DiagnosticResult,
  DiagnosticSession,
  SessionStatus,
} from "../diagnostic/types";
import type { Database } from "./types";

// ============================================================================
// Input Types
// ============================================================================

/** Input for creating a new diagnostic session */
export interface NewDiagnosticSession {
  url: string;
  normalizedUrl: string;
}

// ============================================================================
// Storage Class
// ============================================================================

export class DiagnosticSessionStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Create a new diagnostic session with all agents initialized to 'pending'.
   * Generates a random token for polling and sets a 7-day expiry.
   */
  async create(session: NewDiagnosticSession): Promise<DiagnosticSession> {
    const id = crypto.randomUUID();
    // URL-safe random token (base64url, 32 bytes = 43 chars)
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...tokenBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const now = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const initialAgents: Record<DiagnosticAgentId, AgentStatus> = {
      web_performance: { status: "pending" },
      seo: { status: "pending" },
      tech_stack: { status: "pending" },
      company_context: { status: "pending" },
    };

    const initialResults: DiagnosticResult = {};

    await this.db
      .insertInto("diagnostic_sessions")
      .values({
        id,
        token,
        url: session.url,
        normalized_url: session.normalizedUrl,
        status: "pending",
        agents: JSON.stringify(initialAgents),
        results: JSON.stringify(initialResults),
        organization_id: null,
        project_id: null,
        created_at: now,
        updated_at: now,
        expires_at: expiresAt,
      })
      .execute();

    return {
      id,
      token,
      url: session.url,
      normalizedUrl: session.normalizedUrl,
      status: "pending",
      agents: initialAgents,
      results: initialResults,
      organizationId: null,
      projectId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
  }

  /**
   * Find a session by its polling token.
   * Returns null if not found.
   */
  async findByToken(token: string): Promise<DiagnosticSession | null> {
    const row = await this.db
      .selectFrom("diagnostic_sessions")
      .selectAll()
      .where("token", "=", token)
      .executeTakeFirst();

    if (!row) return null;
    return this.fromDbRow(row);
  }

  /**
   * Find the most recent completed session for a normalized URL within the given time window.
   * Used for the 24-hour result cache — avoids re-scanning a URL scanned recently.
   */
  async findRecentByNormalizedUrl(
    normalizedUrl: string,
    maxAgeMs: number,
  ): Promise<DiagnosticSession | null> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const row = await this.db
      .selectFrom("diagnostic_sessions")
      .selectAll()
      .where("normalized_url", "=", normalizedUrl)
      .where("status", "=", "completed")
      .where("created_at", ">", cutoff as unknown as Date)
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    if (!row) return null;
    return this.fromDbRow(row);
  }

  /**
   * Update a single agent's status within a session.
   * Reads the current agents JSON, updates the target agent, and writes back.
   */
  async updateAgentStatus(
    token: string,
    agentId: DiagnosticAgentId,
    status: AgentStatus,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("diagnostic_sessions")
      .select(["agents"])
      .where("token", "=", token)
      .executeTakeFirst();

    if (!row) return;

    const agents = this.parseJson<Record<DiagnosticAgentId, AgentStatus>>(
      row.agents as unknown as string,
    );
    agents[agentId] = status;

    await this.db
      .updateTable("diagnostic_sessions")
      .set({
        agents: JSON.stringify(agents),
        updated_at: new Date().toISOString(),
      })
      .where("token", "=", token)
      .execute();
  }

  /**
   * Merge an agent's result into the session's results JSON.
   * Uses a read-modify-write pattern (atomic per row via sequential calls).
   */
  async updateResults(
    token: string,
    agentId: keyof DiagnosticResult,
    result: unknown,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("diagnostic_sessions")
      .select(["results"])
      .where("token", "=", token)
      .executeTakeFirst();

    if (!row) return;

    const results = this.parseJson<DiagnosticResult>(
      row.results as unknown as string,
    );
    (results as Record<string, unknown>)[agentId] = result;

    await this.db
      .updateTable("diagnostic_sessions")
      .set({
        results: JSON.stringify(results),
        updated_at: new Date().toISOString(),
      })
      .where("token", "=", token)
      .execute();
  }

  /**
   * Update the overall session status.
   */
  async updateSessionStatus(
    token: string,
    status: SessionStatus,
  ): Promise<void> {
    await this.db
      .updateTable("diagnostic_sessions")
      .set({
        status,
        updated_at: new Date().toISOString(),
      })
      .where("token", "=", token)
      .execute();
  }

  /**
   * Associate a completed session with an organization (and optionally project).
   * Called post-login when the user claims their pre-auth session.
   */
  async associateOrg(
    token: string,
    organizationId: string,
    projectId?: string,
  ): Promise<void> {
    await this.db
      .updateTable("diagnostic_sessions")
      .set({
        organization_id: organizationId,
        project_id: projectId ?? null,
        updated_at: new Date().toISOString(),
      })
      .where("token", "=", token)
      .execute();
  }

  /**
   * Delete all sessions whose expires_at is in the past.
   * Returns the number of deleted rows.
   */
  async deleteExpired(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db
      .deleteFrom("diagnostic_sessions")
      .where("expires_at", "<", now)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0n);
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private parseJson<T>(value: string | T): T {
    if (typeof value === "string") {
      return JSON.parse(value) as T;
    }
    return value;
  }

  private fromDbRow(row: {
    id: string;
    token: string;
    url: string;
    normalized_url: string;
    status: string;
    agents: unknown;
    results: unknown;
    organization_id: string | null;
    project_id: string | null;
    created_at: Date | string;
    updated_at: Date | string;
    expires_at: string;
  }): DiagnosticSession {
    return {
      id: row.id,
      token: row.token,
      url: row.url,
      normalizedUrl: row.normalized_url,
      status: row.status as SessionStatus,
      agents: this.parseJson<Record<DiagnosticAgentId, AgentStatus>>(
        row.agents as string,
      ),
      results: this.parseJson<DiagnosticResult>(row.results as string),
      organizationId: row.organization_id,
      projectId: row.project_id,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : row.updated_at,
      expiresAt: row.expires_at,
    };
  }
}
