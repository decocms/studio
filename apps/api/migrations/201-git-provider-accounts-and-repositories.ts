import { type Kysely, sql } from "kysely";

/**
 * First-class git repositories.
 *
 * Until now a repository was an `owner/name` pair scattered across JSON
 * (`connections.metadata.repoScope`, `*.metadata.githubRepo`) and denormalized
 * column pairs (`task_board_item_prs.repo_owner/repo_name`, `org_repo_sync`),
 * and the only provider discriminator was `connections.slug = 'mcp-github'`.
 * Two tables replace that:
 *
 * - `git_provider_accounts` — the credential holder. `type` picks the provider
 *   client (github | gitlab); `auth_kind` says how it authenticates. A GitHub
 *   App installation stores no grant at all (Studio mints from the App key);
 *   OAuth and token accounts keep their grant in
 *   `git_provider_account_credentials`, encrypted like `downstream_tokens`.
 *   `credential_connection_id` bridges backfilled accounts to the legacy
 *   `mcp-github` connection whose grant they still borrow.
 * - `repositories` — one row per (org, host, path), case-insensitive.
 *   `account_id` NULL is an anonymous public clone. `legacy_connection_id`
 *   points at the repo-scoped `mcp-github` child whose token still clones the
 *   repo until the org connects through Studio's own GitHub App.
 *
 * Consumers gain a nullable `repository_id` FK; their legacy columns stay
 * readable until every reader has moved (dual-read, then drop).
 *
 * The backfill is SQL-only and idempotent: accounts from distinct
 * (org, installationId) in repoScope metadata; repositories from repoScope,
 * agents' `metadata.githubRepo`, `task_board_items.repo`, `org_repo_sync` and
 * `task_board_item_prs`. Thread metadata is not touched here (hot, large
 * table); readers resolve threads by identity and stamp lazily.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE git_provider_accounts (
      id text PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      type text NOT NULL CHECK (type IN ('github', 'gitlab')),
      host text NOT NULL,
      auth_kind text NOT NULL CHECK (auth_kind IN ('github_app', 'oauth', 'token')),
      external_account_id text NOT NULL,
      login text NOT NULL,
      avatar_url text,
      installation_id bigint,
      credential_connection_id text REFERENCES connections(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, host, external_account_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE git_provider_account_credentials (
      account_id text PRIMARY KEY REFERENCES git_provider_accounts(id) ON DELETE CASCADE,
      access_token text NOT NULL,
      refresh_token text,
      scope text,
      expires_at timestamptz,
      client_id text,
      client_secret text,
      token_endpoint text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  /**
   * Single-use proof that a git provider OAuth redirect was started by this
   * org+user, plus where to send the browser afterwards. The provider echoes
   * only the id back, so the row is the whole state; rows are consumed on
   * callback and pruned by expiry.
   */
  await sql`
    CREATE TABLE git_provider_oauth_states (
      id text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      provider text NOT NULL CHECK (provider IN ('github', 'gitlab')),
      host text NOT NULL,
      return_to text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE INDEX idx_git_provider_oauth_states_expires_at
      ON git_provider_oauth_states (expires_at)
  `.execute(db);

  await sql`
    CREATE TABLE repositories (
      id text PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      account_id text REFERENCES git_provider_accounts(id) ON DELETE SET NULL,
      provider text NOT NULL CHECK (provider IN ('github', 'gitlab')),
      host text NOT NULL,
      path text NOT NULL,
      external_id text,
      default_branch text,
      web_url text NOT NULL,
      visibility text CHECK (visibility IN ('public', 'private', 'internal')),
      legacy_connection_id text REFERENCES connections(id) ON DELETE SET NULL,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX uq_repositories_org_host_path
      ON repositories (organization_id, host, lower(path))
  `.execute(db);
  await sql`
    CREATE INDEX idx_repositories_account ON repositories (account_id)
  `.execute(db);

  await sql`
    ALTER TABLE task_board_items
      ADD COLUMN repository_id text REFERENCES repositories(id) ON DELETE SET NULL
  `.execute(db);
  await sql`
    ALTER TABLE task_board_item_prs
      ADD COLUMN repository_id text REFERENCES repositories(id) ON DELETE SET NULL
  `.execute(db);
  await sql`
    ALTER TABLE org_repo_sync
      ADD COLUMN repository_id text REFERENCES repositories(id) ON DELETE SET NULL
  `.execute(db);

  /**
   * ── Backfill ──
   *
   * `connections.metadata` is TEXT holding a JSON string, so every read casts.
   * The cast is wrapped so one malformed row cannot abort the migration (the
   * same defensive pattern migration 125 used); the helper is dropped again at
   * the end, under its own name so it cannot collide with another migration's.
   */
  await sql`
    CREATE OR REPLACE FUNCTION git_provider_try_jsonb(t text)
    RETURNS jsonb AS $fn$
    BEGIN
      RETURN t::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
    $fn$ LANGUAGE plpgsql IMMUTABLE;
  `.execute(db);

  /**
   * Accounts: one per (org, GitHub App installation) seen in a repo-scoped
   * mcp-github child. The installation's login is not recorded in repoScope;
   * the repo owner is the installation account for user/org installs.
   */
  await sql`
    INSERT INTO git_provider_accounts (
      organization_id, type, host, auth_kind, external_account_id, login,
      installation_id, credential_connection_id, created_by
    )
    SELECT DISTINCT ON (c.organization_id, s.installation_id)
      c.organization_id,
      'github',
      'github.com',
      'github_app',
      s.installation_id,
      s.owner,
      s.installation_id::bigint,
      (
        SELECT o.id FROM connections o
        WHERE o.organization_id = c.organization_id
          AND o.slug = 'mcp-github'
          AND o.status = 'active'
          AND git_provider_try_jsonb(o.metadata) -> 'repoScope' IS NULL
        ORDER BY o.created_at ASC
        LIMIT 1
      ),
      c.created_by
    FROM connections c
    CROSS JOIN LATERAL (
      SELECT
        git_provider_try_jsonb(c.metadata) #>> '{repoScope,installationId}' AS installation_id,
        git_provider_try_jsonb(c.metadata) #>> '{repoScope,owner}' AS owner
    ) s
    WHERE c.slug = 'mcp-github'
      AND s.installation_id ~ '^[0-9]+$'
      AND coalesce(s.owner, '') <> ''
    ORDER BY c.organization_id, s.installation_id, c.created_at ASC
    ON CONFLICT (organization_id, host, external_account_id) DO NOTHING
  `.execute(db);

  /**
   * Repositories from repo-scoped children. The org-shared connection wins as
   * the legacy credential when several children cover one repo (it outlives
   * any single agent), mirroring findReusableRepoConnection.
   */
  await sql`
    INSERT INTO repositories (
      organization_id, account_id, provider, host, path, external_id, web_url,
      legacy_connection_id, created_by
    )
    SELECT DISTINCT ON (c.organization_id, lower(s.owner || '/' || s.repo))
      c.organization_id,
      a.id,
      'github',
      'github.com',
      s.owner || '/' || s.repo,
      nullif(s.repository_id, ''),
      'https://github.com/' || s.owner || '/' || s.repo,
      c.id,
      c.created_by
    FROM connections c
    CROSS JOIN LATERAL (
      SELECT
        git_provider_try_jsonb(c.metadata) #>> '{repoScope,owner}' AS owner,
        git_provider_try_jsonb(c.metadata) #>> '{repoScope,repo}' AS repo,
        git_provider_try_jsonb(c.metadata) #>> '{repoScope,installationId}' AS installation_id,
        git_provider_try_jsonb(c.metadata) #>> '{repoScope,repositoryId}' AS repository_id,
        git_provider_try_jsonb(c.metadata) #>> '{orgShared}' AS org_shared
    ) s
    LEFT JOIN git_provider_accounts a
      ON a.organization_id = c.organization_id
     AND a.host = 'github.com'
     AND a.external_account_id = s.installation_id
    WHERE c.slug = 'mcp-github'
      AND c.status = 'active'
      AND coalesce(s.owner, '') <> ''
      AND coalesce(s.repo, '') <> ''
      AND s.owner NOT LIKE '%/%'
      AND s.repo NOT LIKE '%/%'
    ORDER BY c.organization_id, lower(s.owner || '/' || s.repo),
             coalesce(s.org_shared = 'true', false) DESC, c.created_at ASC
    ON CONFLICT (organization_id, host, lower(path)) DO NOTHING
  `.execute(db);

  /**
   * The winning connection above is the longest-lived one, which is not
   * necessarily the one that recorded the provider's repository id — fill it
   * from any child covering the same repo.
   */
  await sql`
    UPDATE repositories r
       SET external_id = s.repository_id
      FROM connections c
      CROSS JOIN LATERAL (
        SELECT
          git_provider_try_jsonb(c.metadata) #>> '{repoScope,owner}' AS owner,
          git_provider_try_jsonb(c.metadata) #>> '{repoScope,repo}' AS repo,
          git_provider_try_jsonb(c.metadata) #>> '{repoScope,repositoryId}' AS repository_id
      ) s
     WHERE r.external_id IS NULL
       AND r.host = 'github.com'
       AND c.organization_id = r.organization_id
       AND coalesce(s.repository_id, '') <> ''
       AND lower(s.owner || '/' || s.repo) = lower(r.path)
  `.execute(db);

  /**
   * Repositories agents point at without a repo-scoped child (public clones,
   * or children that were deleted). Virtual MCPs are connections rows.
   */
  await sql`
    INSERT INTO repositories (
      organization_id, account_id, provider, host, path, web_url, created_by
    )
    SELECT DISTINCT ON (c.organization_id, lower(g.owner || '/' || g.name))
      c.organization_id,
      NULL,
      'github',
      'github.com',
      g.owner || '/' || g.name,
      'https://github.com/' || g.owner || '/' || g.name,
      c.created_by
    FROM connections c
    CROSS JOIN LATERAL (
      SELECT
        git_provider_try_jsonb(c.metadata) #>> '{githubRepo,owner}' AS owner,
        git_provider_try_jsonb(c.metadata) #>> '{githubRepo,name}' AS name
    ) g
    WHERE coalesce(g.owner, '') <> ''
      AND coalesce(g.name, '') <> ''
      AND g.owner NOT LIKE '%/%'
      AND g.name NOT LIKE '%/%'
    ORDER BY c.organization_id, lower(g.owner || '/' || g.name), c.created_at ASC
    ON CONFLICT (organization_id, host, lower(path)) DO NOTHING
  `.execute(db);

  // Repositories only the task board / repo sync know about.
  await sql`
    INSERT INTO repositories (
      organization_id, account_id, provider, host, path, web_url
    )
    SELECT DISTINCT ON (x.organization_id, lower(x.path))
      x.organization_id, NULL, 'github', 'github.com', x.path,
      'https://github.com/' || x.path
    FROM (
      SELECT organization_id, repo AS path FROM task_board_items
        WHERE repo IS NOT NULL AND repo ~ '^[^/[:space:]]+/[^/[:space:]]+$'
      UNION ALL
      SELECT organization_id, repo_owner || '/' || repo_name FROM task_board_item_prs
      UNION ALL
      SELECT organization_id, repo_owner || '/' || repo_name FROM org_repo_sync
    ) x
    WHERE EXISTS (SELECT 1 FROM organization o WHERE o.id = x.organization_id)
    ORDER BY x.organization_id, lower(x.path)
    ON CONFLICT (organization_id, host, lower(path)) DO NOTHING
  `.execute(db);

  // Point the SQL-shaped consumers at their repository row.
  await sql`
    UPDATE task_board_items t
       SET repository_id = r.id
      FROM repositories r
     WHERE t.repository_id IS NULL
       AND t.repo IS NOT NULL
       AND r.organization_id = t.organization_id
       AND r.host = 'github.com'
       AND lower(r.path) = lower(t.repo)
  `.execute(db);
  await sql`
    UPDATE task_board_item_prs p
       SET repository_id = r.id
      FROM repositories r
     WHERE p.repository_id IS NULL
       AND r.organization_id = p.organization_id
       AND r.host = 'github.com'
       AND lower(r.path) = lower(p.repo_owner || '/' || p.repo_name)
  `.execute(db);
  await sql`
    UPDATE org_repo_sync s
       SET repository_id = r.id
      FROM repositories r
     WHERE s.repository_id IS NULL
       AND r.organization_id = s.organization_id
       AND r.host = 'github.com'
       AND lower(r.path) = lower(s.repo_owner || '/' || s.repo_name)
  `.execute(db);

  await sql`DROP FUNCTION IF EXISTS git_provider_try_jsonb(text)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE org_repo_sync DROP COLUMN IF EXISTS repository_id`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_item_prs DROP COLUMN IF EXISTS repository_id`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_items DROP COLUMN IF EXISTS repository_id`.execute(
    db,
  );
  await sql`DROP TABLE IF EXISTS repositories`.execute(db);
  await sql`DROP TABLE IF EXISTS git_provider_oauth_states`.execute(db);
  await sql`DROP TABLE IF EXISTS git_provider_account_credentials`.execute(db);
  await sql`DROP TABLE IF EXISTS git_provider_accounts`.execute(db);
}
