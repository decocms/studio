import { type Kysely, sql } from "kysely";

/**
 * The Reports diagnostic's repository, as a reference instead of a
 * string.
 *
 * An onboarded org carries its pick as `configuration_state.github_repo` on the
 * Reports connection: a bare `owner/name`, github.com by
 * construction. That string cannot name a GitLab project in nested subgroups,
 * cannot tell two hosts apart, and cannot be resolved back to a credential —
 * which is the whole reason the audit only ever worked for GitHub.
 *
 * This backfills the same pick as `configuration_state.repository`, a reference
 * to a `repositories` row. Where no row exists for that identity yet, one is
 * created with a null account: the repository IS in that org, Studio just has
 * no credential for it, and `resolveRepoTarget` already reports that honestly
 * (`no_account`) rather than pretending the repository is gone. The same
 * reference lands on the org's Report Agent, whose `metadata.githubRepo` gains
 * a `repositoryId` and whose `repository_id` column follows it — that is what
 * makes its clone authenticate through the repository's own account.
 *
 * EXPAND ONLY. `github_repo` stays written and readable: during a rolling
 * deploy both versions serve traffic, and the consumer reads both for a
 * deprecation window. A later release drops the string.
 *
 * Both well-known ids are deterministic per org, so the rows are matched by
 * their shape rather than by a list: the connection is `<org>_commerce-discovery`
 * and the agent is `commerce-discovery_<org>`.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  /** `configuration_state` and `metadata` are TEXT holding JSON; a row that
   *  never parsed must not fail the migration. */
  await sql`
    CREATE OR REPLACE FUNCTION cd_repo_try_jsonb(t text)
    RETURNS jsonb AS $fn$
    BEGIN
      RETURN t::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
    $fn$ LANGUAGE plpgsql IMMUTABLE;
  `.execute(db);

  await sql`
    CREATE OR REPLACE VIEW cd_repo_picks AS
    SELECT
      c.id AS connection_id,
      c.organization_id,
      cd_repo_try_jsonb(c.configuration_state) ->> 'github_repo' AS path
    FROM connections c
    WHERE c.id = c.organization_id || '_commerce-discovery'
      AND cd_repo_try_jsonb(c.configuration_state) ->> 'github_repo'
          ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' 
  `.execute(db);

  /**
   * A row per identity, account-less. The unique key is
   * (organization_id, host, lower(path)), so an org that already linked the
   * repository through Settings keeps the row it has — account and all.
   */
  await sql`
    INSERT INTO repositories (
      organization_id, account_id, provider, host, path, web_url
    )
    SELECT DISTINCT ON (p.organization_id, lower(p.path))
      p.organization_id, NULL, 'github', 'github.com',
      p.path, 'https://github.com/' || p.path
    FROM cd_repo_picks p
    ORDER BY p.organization_id, lower(p.path)
    ON CONFLICT (organization_id, host, lower(path)) DO NOTHING
  `.execute(db);

  /**
   * The reference, alongside the string it was derived from. `||` on the
   * parsed state preserves every other key the MCP put there; a state that
   * already names a repository is left alone, so a re-run is a no-op.
   */
  await sql`
    UPDATE connections c
    SET configuration_state = (
      cd_repo_try_jsonb(c.configuration_state) || jsonb_build_object(
        'repository', jsonb_build_object(
          'repository_id', r.id,
          'provider', r.provider,
          'host', r.host,
          'path', r.path,
          'default_branch', r.default_branch,
          'web_url', r.web_url
        )
      )
    )::text
    FROM cd_repo_picks p
    JOIN repositories r
      ON r.organization_id = p.organization_id
     AND r.host = 'github.com'
     AND lower(r.path) = lower(p.path)
    WHERE c.id = p.connection_id
      AND cd_repo_try_jsonb(c.configuration_state) -> 'repository' IS NULL
  `.execute(db);

  /**
   * The Report Agent's binding. Only the id is added — the owner/name/url it
   * already carries are what a reader predating this still uses, and
   * overwriting them would be a rewrite rather than an expand. An agent bound
   * to a DIFFERENT repository than the diagnostic's is left alone: someone
   * chose that, and this migration is not the place to overrule it.
   */
  await sql`
    UPDATE connections a
    SET
      repository_id = r.id,
      metadata = (
        coalesce(cd_repo_try_jsonb(a.metadata), '{}'::jsonb) || jsonb_build_object(
          'githubRepo',
          coalesce(cd_repo_try_jsonb(a.metadata) -> 'githubRepo', '{}'::jsonb)
            || jsonb_build_object('repositoryId', r.id)
        )
      )::text
    FROM cd_repo_picks p
    JOIN repositories r
      ON r.organization_id = p.organization_id
     AND r.host = 'github.com'
     AND lower(r.path) = lower(p.path)
    WHERE a.id = 'commerce-discovery_' || p.organization_id
      AND a.organization_id = p.organization_id
      AND a.repository_id IS NULL
      AND lower(
            coalesce(cd_repo_try_jsonb(a.metadata) #>> '{githubRepo,owner}', '')
            || '/' ||
            coalesce(cd_repo_try_jsonb(a.metadata) #>> '{githubRepo,name}', '')
          ) = lower(p.path)
  `.execute(db);

  await sql`DROP VIEW IF EXISTS cd_repo_picks`.execute(db);
  await sql`DROP FUNCTION IF EXISTS cd_repo_try_jsonb(text)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  /**
   * Remove only what the expand added. `github_repo` was never touched, so
   * every reader that predates this finds its pick exactly where it was, and
   * the `repositories` rows stay — they are a real inventory of the org's
   * repositories, not bookkeeping for this migration.
   */
  await sql`
    CREATE OR REPLACE FUNCTION cd_repo_try_jsonb(t text)
    RETURNS jsonb AS $fn$
    BEGIN
      RETURN t::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
    $fn$ LANGUAGE plpgsql IMMUTABLE;
  `.execute(db);

  await sql`
    UPDATE connections c
    SET configuration_state =
      (cd_repo_try_jsonb(c.configuration_state) - 'repository')::text
    WHERE c.id = c.organization_id || '_commerce-discovery'
      AND cd_repo_try_jsonb(c.configuration_state) -> 'repository' IS NOT NULL
  `.execute(db);

  await sql`
    UPDATE connections a
    SET
      repository_id = NULL,
      metadata = (
        cd_repo_try_jsonb(a.metadata) || jsonb_build_object(
          'githubRepo',
          (cd_repo_try_jsonb(a.metadata) -> 'githubRepo') - 'repositoryId'
        )
      )::text
    WHERE a.id = 'commerce-discovery_' || a.organization_id
      AND cd_repo_try_jsonb(a.metadata) #> '{githubRepo,repositoryId}' IS NOT NULL
  `.execute(db);

  await sql`DROP FUNCTION IF EXISTS cd_repo_try_jsonb(text)`.execute(db);
}
