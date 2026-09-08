import { type Kysely, sql } from "kysely";

/**
 * The last two repository bindings that were still JSON.
 *
 * Migration 204 gave `task_board_items`, `task_board_item_prs` and
 * `org_repo_sync` a real `repository_id`, but left the two bindings that
 * matter most to a person using the product:
 *
 * - an AGENT's repository (`connections.metadata.githubRepo`, since a virtual
 *   MCP is a `connections` row) — the thing a project IS;
 * - a THREAD's extra checkouts (`threads.metadata.githubRepos`), the list
 *   `TASK_ADD_REPO` appends to so one run can hold several repositories.
 *
 * Leaving those in JSON cost three things. A deleted repository left every
 * agent pointing at nothing, with no FK to say so. "Which agents use this
 * repository" was a JSON scan. And `resolveRepoTarget` had to keep a
 * resolve-by-identity step — a lowercase path match, per request — purely
 * because the binding carried no id.
 *
 * The thread list also loses a real bug with the normalisation. Its append is
 * a `jsonb_agg` rebuild inside one UPDATE, written that way because two
 * concurrent `TASK_ADD_REPO` calls lost each other under read-modify-write —
 * with the pod already holding the checkout the lost entry described, so
 * nothing looked wrong until the pod was recreated without it. A unique key
 * makes that an `ON CONFLICT DO NOTHING`. Its dedup key was also
 * `lower(owner/name)` with no host, so two `acme/site` on different hosts
 * collided; a reference to a row cannot.
 *
 * EXPAND ONLY. The JSON stays written and readable: during a rolling deploy
 * both versions serve traffic, and a reader that predates this migration must
 * still find its binding. Readers prefer the reference and fall back to JSON;
 * a later release removes the fallback, and a third drops the JSON.
 *
 * The backfill only has to LINK, not create: 204 already made a `repositories`
 * row for every agent binding (its fourth insert, with a null account). Thread
 * metadata was deliberately excluded there, so the rows those need are created
 * here first.
 */

/**
 * `connections.metadata` is TEXT holding JSON, and a row that is not valid
 * JSON must not abort the migration. Mirrors 201's helper, which drops itself;
 * `threads.metadata` is real jsonb and needs none of this.
 */
const CREATE_TRY_JSONB = sql`
  CREATE OR REPLACE FUNCTION repo_ref_try_jsonb(value text)
  RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
  BEGIN
    RETURN value::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  $$
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await CREATE_TRY_JSONB.execute(db);

  /**
   * SET NULL, matching 201's consumers: unlinking a repository must not delete
   * the agent, which owns threads, tasks and history of its own. It reverts to
   * an unbound project, which is a state the product already renders.
   */
  await sql`
    ALTER TABLE connections
      ADD COLUMN repository_id text REFERENCES repositories(id) ON DELETE SET NULL
  `.execute(db);
  // Partial: 311 of 11,575 rows carry one, and the reverse lookup is the point.
  await sql`
    CREATE INDEX idx_connections_repository
      ON connections (repository_id) WHERE repository_id IS NOT NULL
  `.execute(db);

  /**
   * CASCADE on both sides, unlike the agent's binding: a checkout entry is
   * meaningless without its thread AND without its repository, and it carries
   * nothing a person would miss.
   */
  await sql`
    CREATE TABLE thread_repositories (
      thread_id text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (thread_id, repository_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX idx_thread_repositories_repo
      ON thread_repositories (repository_id)
  `.execute(db);

  /**
   * An agent's repository. Every one of these rows exists already (201), so
   * this only links.
   *
   * The owner/name pair is read inline rather than through a LATERAL: in an
   * `UPDATE ... FROM`, the target table is not in the FROM list's lateral
   * scope, so a LATERAL cannot see `c`. Concatenating with `||` also does the
   * filtering for free — a missing half, or metadata that is not JSON at all,
   * yields NULL and matches nothing.
   */
  await sql`
    UPDATE connections c
       SET repository_id = r.id
      FROM repositories r
     WHERE c.repository_id IS NULL
       AND r.organization_id = c.organization_id
       AND r.host = 'github.com'
       AND lower(r.path) = lower(
             (repo_ref_try_jsonb(c.metadata) #>> '{githubRepo,owner}')
             || '/' ||
             (repo_ref_try_jsonb(c.metadata) #>> '{githubRepo,name}')
           )
  `.execute(db);

  /**
   * Repositories only a thread's checkout list knows about — 201 skipped
   * threads, so unlike the agent binding these may genuinely not exist yet.
   * Anonymous (`account_id` null), like every other identity-only source.
   */
  await sql`
    INSERT INTO repositories (
      organization_id, account_id, provider, host, path, web_url
    )
    SELECT DISTINCT ON (t.organization_id, lower(e.owner || '/' || e.name))
      t.organization_id, NULL, 'github', 'github.com',
      e.owner || '/' || e.name,
      'https://github.com/' || e.owner || '/' || e.name
    FROM threads t
    CROSS JOIN LATERAL jsonb_array_elements(
      coalesce(t.metadata -> 'githubRepos', '[]'::jsonb)
    ) AS entry
    CROSS JOIN LATERAL (
      SELECT entry ->> 'owner' AS owner, entry ->> 'name' AS name
    ) e
    WHERE coalesce(e.owner, '') <> ''
      AND coalesce(e.name, '') <> ''
      AND e.owner NOT LIKE '%/%'
      AND e.name NOT LIKE '%/%'
    ORDER BY t.organization_id, lower(e.owner || '/' || e.name)
    ON CONFLICT (organization_id, host, lower(path)) DO NOTHING
  `.execute(db);

  await sql`
    INSERT INTO thread_repositories (thread_id, organization_id, repository_id)
    SELECT DISTINCT t.id, t.organization_id, r.id
    FROM threads t
    CROSS JOIN LATERAL jsonb_array_elements(
      coalesce(t.metadata -> 'githubRepos', '[]'::jsonb)
    ) AS entry
    JOIN repositories r
      ON r.organization_id = t.organization_id
     AND r.host = 'github.com'
     AND lower(r.path) = lower((entry ->> 'owner') || '/' || (entry ->> 'name'))
    ON CONFLICT (thread_id, repository_id) DO NOTHING
  `.execute(db);

  await sql`DROP FUNCTION IF EXISTS repo_ref_try_jsonb(text)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  /**
   * The JSON was never removed, so dropping these loses nothing: every reader
   * that predates the expand still finds its binding where it always was.
   */
  await sql`DROP TABLE IF EXISTS thread_repositories`.execute(db);
  await sql`
    ALTER TABLE connections DROP COLUMN IF EXISTS repository_id
  `.execute(db);
}
