import { type Kysely, sql } from "kysely";

/** Keep legacy writers coherent during rolling deploys and commerce imports.
 * The trigger only translates repo-scoped GitHub connections into repository
 * rows. Existing provider credentials and explicit repository links win. */
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE FUNCTION adopt_legacy_repository() RETURNS trigger AS $$
    DECLARE
      metadata_json jsonb;
      scope jsonb;
      account_key text;
      source_key text;
      repo_path text;
    BEGIN
      IF NEW.slug IS DISTINCT FROM 'mcp-github' THEN RETURN NEW; END IF;
      BEGIN metadata_json := NEW.metadata::jsonb;
      EXCEPTION WHEN others THEN RETURN NEW;
      END;
      scope := metadata_json -> 'repoScope';
      IF coalesce(scope ->> 'owner', '') = '' OR coalesce(scope ->> 'repo', '') = ''
        OR coalesce(scope ->> 'installationId', '') !~ '^[0-9]{1,15}$'
        THEN RETURN NEW;
      END IF;
      repo_path := (scope ->> 'owner') || '/' || (scope ->> 'repo');
      -- A disconnected account must not be recreated by unrelated metadata writes.
      IF EXISTS (SELECT 1 FROM repositories WHERE organization_id = NEW.organization_id
        AND host = 'github.com' AND lower(path) = lower(repo_path)
        AND legacy_connection_id IS NOT NULL) THEN RETURN NEW; END IF;
      SELECT id INTO source_key FROM connections
        WHERE organization_id = NEW.organization_id AND slug = 'mcp-github'
          AND id = scope ->> 'sourceConnectionId';
      INSERT INTO git_provider_accounts (
        organization_id, type, host, auth_kind, external_account_id, login,
        installation_id, credential_connection_id, created_by
      ) VALUES (
        NEW.organization_id, 'github', 'github.com', 'github_app', scope ->> 'installationId',
        scope ->> 'owner', (scope ->> 'installationId')::bigint, source_key, NEW.created_by
      ) ON CONFLICT (organization_id, host, external_account_id) DO NOTHING;
      SELECT id INTO account_key FROM git_provider_accounts
        WHERE organization_id = NEW.organization_id AND host = 'github.com'
          AND external_account_id = scope ->> 'installationId';
      INSERT INTO repositories (
        organization_id, account_id, provider, host, path, web_url, legacy_connection_id, created_by
      ) VALUES (
        NEW.organization_id, account_key, 'github', 'github.com', repo_path,
        'https://github.com/' || repo_path, NEW.id, NEW.created_by
      ) ON CONFLICT (organization_id, host, lower(path)) DO UPDATE SET
        account_id = coalesce(repositories.account_id, EXCLUDED.account_id),
        legacy_connection_id = coalesce(repositories.legacy_connection_id, EXCLUDED.legacy_connection_id);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER connection_repository_compat
      AFTER INSERT OR UPDATE OF metadata ON connections
      FOR EACH ROW EXECUTE FUNCTION adopt_legacy_repository();
    UPDATE connections SET metadata = metadata WHERE slug = 'mcp-github';
  `.execute(db);
  await sql`
    UPDATE org_repo_sync s SET repository_id = r.id
      FROM repositories r WHERE s.repository_id IS NULL
        AND r.organization_id = s.organization_id AND r.host = 'github.com'
        AND lower(r.path) = lower(s.repo_owner || '/' || s.repo_name);
  `.execute(db);
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS connection_repository_compat ON connections`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS adopt_legacy_repository()`.execute(db);
}
