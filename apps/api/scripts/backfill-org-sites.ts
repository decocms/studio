/**
 * Backfill `org_sites` ownership (and `managed` file configs) from the deco
 * admin platform into studio — the migration step that moves asset tenancy into
 * studio's own DB.
 *
 * Studio has NO persisted studio-org ↔ deco-team link, so ownership is sourced
 * from an explicit, hand-maintained MAPPING (deco team id → studio org id). Run
 * it incrementally: add entries as orgs are created, re-run safely (idempotent).
 *
 * For each mapped team it reads admin Supabase for the team's sites, then per
 * site: (1) claims the slug in `org_sites` for the org, and (2) ensures a
 * `managed` file config exists — converting a legacy `sts-session`
 * `deco-assets-<slug>` row (the old admin bridge) to `managed`, or creating one.
 *
 * Run (from apps/api):
 *   DATABASE_URL=... ENCRYPTION_KEY=... \
 *   DECO_SUPABASE_URL=... DECO_SUPABASE_SERVICE_KEY=... \
 *   bun run scripts/backfill-org-sites.ts [--dry-run] [--mapping=<path.json>]
 *
 * --dry-run         report what would change without writing.
 * --sql             DON'T touch the DB — print idempotent SQL to stdout instead
 *                   (for when you can't connect to Postgres directly). Only
 *                   needs DECO_SUPABASE_URL/SERVICE_KEY; redirect to a .sql file
 *                   and run it in your DB client. Progress goes to stderr.
 * --mapping=<path>  load the mapping from a JSON file [{decoTeamId, organizationId}]
 *                   instead of the inline MAPPING below.
 */

import { readFileSync } from "node:fs";
import { createDatabase } from "../src/database";
import { CredentialVault } from "../src/encryption/credential-vault";
import { tenantStorageDescriptor } from "../src/file-storage/tenant-credentials";
import { getSettings } from "../src/settings";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { OrgFileConfigStorage } from "../src/storage/org-file-configs";
import { OrgSiteConflictError, OrgSiteStorage } from "../src/storage/org-sites";
import { isValidSiteSlug } from "@decocms/shared/site-slug";

interface TeamOrgMapping {
  decoTeamId: number;
  organizationId: string;
}

/**
 * Edit this list (or pass --mapping=<path.json>) with the deco team → studio org
 * pairs to import. Add entries over time as orgs are created.
 */
const MAPPING: TeamOrgMapping[] = [
  // { decoTeamId: 123, organizationId: "org_abc" },
];

const ACTOR = "system:backfill-org-sites";
const FILE_CONFIG_NAME_PREFIX = "deco-assets-";

interface AdminSite {
  name: string;
}

async function fetchTeamSites(
  supabaseUrl: string,
  serviceKey: string,
  teamId: number,
): Promise<AdminSite[]> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/sites?team=eq.${teamId}&select=name&order=name`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`admin sites fetch failed (${res.status}): ${text}`);
  }
  return (await res.json()) as AdminSite[];
}

function loadMapping(): TeamOrgMapping[] {
  const arg = process.argv.find((a) => a.startsWith("--mapping="));
  if (!arg) return MAPPING;
  const path = arg.slice("--mapping=".length);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as TeamOrgMapping[];
  if (!Array.isArray(parsed)) {
    throw new Error(
      "--mapping file must be a JSON array of {decoTeamId, organizationId}",
    );
  }
  return parsed;
}

/** Single-quote a SQL string literal (escape embedded quotes). */
function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Emit idempotent SQL for one (org, slug) pair — safe to run repeatedly:
 *   1. claim ownership (ON CONFLICT keeps an existing owner, never steals)
 *   2. convert a legacy sts-session deco-assets config to managed
 *   3. create a managed config only if none exists for the name
 */
function emitSqlForSite(organizationId: string, slug: string): string {
  const configName = `${FILE_CONFIG_NAME_PREFIX}${slug}`;
  const d = tenantStorageDescriptor(slug);
  const fcfgId = generatePrefixedId("fcfg");
  const endpoint = d.endpoint === null ? "NULL" : sql(d.endpoint);
  const o = sql(organizationId);
  const s = sql(slug);
  const name = sql(configName);
  const actor = sql(ACTOR);

  return [
    `-- org=${organizationId}  site="${slug}"`,
    `INSERT INTO org_sites (slug, organization_id, source, created_by, updated_by)`,
    `VALUES (${s}, ${o}, 'deco-import', ${actor}, ${actor})`,
    `ON CONFLICT (slug) DO NOTHING;`,
    ``,
    // Repoint storage too: a legacy row points at the OLD assets bucket, and
    // the STS session policy only ever grants `<tenantBucket>/<slug>/*`.
    // Flipping credential_type alone would leave a config that looks managed
    // but whose minted credentials can't reach its own bucket.
    `UPDATE org_file_configs`,
    `   SET credential_type = 'managed', site_slug = ${s}, refresh_url = NULL,`,
    `       bucket = ${sql(d.bucket)}, region = ${sql(d.region)}, endpoint = ${endpoint},`,
    `       force_path_style = false, prefix = ${sql(d.prefix)},`,
    `       public_url_base = ${sql(d.publicUrlBase)},`,
    `       updated_at = now(), updated_by = ${actor}`,
    ` WHERE organization_id = ${o}`,
    `   AND lower(name) = lower(${name})`,
    `   AND credential_type <> 'managed';`,
    ``,
    `INSERT INTO org_file_configs`,
    `  (id, organization_id, name, description, bucket, region, endpoint,`,
    `   force_path_style, prefix, public_url_base, credential_type, refresh_url,`,
    `   site_slug, encrypted_credentials, created_by, updated_by)`,
    `SELECT ${sql(fcfgId)}, ${o}, ${name}, ${sql(`Managed deco-assets storage for site "${slug}".`)},`,
    `       ${sql(d.bucket)}, ${sql(d.region)}, ${endpoint}, false, ${sql(d.prefix)},`,
    `       ${sql(d.publicUrlBase)}, 'managed', NULL, ${s},`,
    // `managed` rows are never decrypted (org-file-configs.decodeCredentials
    // short-circuits), so this sentinel just satisfies the NOT NULL column.
    `       '{"type":"managed"}', ${actor}, ${actor}`,
    ` WHERE NOT EXISTS (`,
    `   SELECT 1 FROM org_file_configs`,
    `    WHERE organization_id = ${o} AND lower(name) = lower(${name})`,
    ` );`,
    ``,
  ].join("\n");
}

/** --sql mode: print idempotent SQL to stdout; never touch the DB. */
async function emitSql(
  mapping: TeamOrgMapping[],
  supabaseUrl: string,
  serviceKey: string,
): Promise<void> {
  let emitted = 0;
  let invalid = 0;
  const blocks: string[] = [];

  for (const { decoTeamId, organizationId } of mapping) {
    let sites: AdminSite[];
    try {
      sites = await fetchTeamSites(supabaseUrl, serviceKey, decoTeamId);
    } catch (err) {
      console.error(`team=${decoTeamId}: ${(err as Error).message}`);
      continue;
    }
    for (const site of sites) {
      const slug = site.name.toLowerCase();
      if (!isValidSiteSlug(slug)) {
        console.error(`  site="${site.name}" invalid slug — skipping`);
        invalid++;
        continue;
      }
      blocks.push(emitSqlForSite(organizationId, slug));
      emitted++;
    }
  }

  // SQL → stdout; everything else → stderr, so `> backfill.sql` stays clean.
  // No wrapping transaction on purpose: statements are idempotent and must run
  // INDEPENDENTLY so a single failure surfaces its real error (and skips only
  // that statement) instead of aborting the whole block with a 25P02 cascade.
  console.log(
    [
      "-- Backfill org_sites + managed file configs (generated).",
      "-- PREREQUISITE: migrations 116 (org_sites) + 117 (org_file_configs.site_slug)",
      "-- must already be applied, or every statement fails. Verify with:",
      "--   SELECT to_regclass('public.org_sites');  -- non-null = 116 applied",
      "-- Statements are independent and idempotent — safe to re-run. A slug",
      "-- already owned by a different org is left untouched (ON CONFLICT DO NOTHING).",
      "",
      ...blocks,
    ].join("\n"),
  );
  console.error(
    `\nEmitted SQL for ${emitted} site(s); skipped ${invalid} invalid.`,
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const sqlMode = process.argv.includes("--sql");
  const settings = getSettings();

  const supabaseUrl = settings.decoSupabaseUrl;
  const serviceKey = settings.decoSupabaseServiceKey;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "DECO_SUPABASE_URL and DECO_SUPABASE_SERVICE_KEY are required",
    );
  }

  const mapping = loadMapping();
  if (mapping.length === 0) {
    console.error(
      "No mappings configured. Edit MAPPING in this script or pass --mapping=<path.json>.",
    );
    return;
  }

  // --sql: no DB connection, no ENCRYPTION_KEY — just print SQL.
  if (sqlMode) {
    await emitSql(mapping, supabaseUrl, serviceKey);
    return;
  }

  if (!settings.encryptionKey) {
    throw new Error("ENCRYPTION_KEY is required to write managed file configs");
  }

  const db = createDatabase(settings.databaseUrl);
  const vault = new CredentialVault(settings.encryptionKey);
  const orgSites = new OrgSiteStorage(db);
  const orgFileConfigs = new OrgFileConfigStorage(db, vault);

  const stats = {
    sites: 0,
    claimed: 0,
    configsCreated: 0,
    configsConverted: 0,
    conflicts: 0,
    invalid: 0,
    skipped: 0,
  };

  console.log(
    `${dryRun ? "[DRY RUN] " : ""}Backfilling ${mapping.length} team→org mapping(s)...`,
  );

  for (const { decoTeamId, organizationId } of mapping) {
    let sites: AdminSite[];
    try {
      sites = await fetchTeamSites(supabaseUrl, serviceKey, decoTeamId);
    } catch (err) {
      console.error(`team=${decoTeamId}: ${(err as Error).message}`);
      continue;
    }

    for (const site of sites) {
      stats.sites++;
      const slug = site.name.toLowerCase();
      if (!isValidSiteSlug(slug)) {
        console.warn(`  site="${site.name}" invalid slug — skipping`);
        stats.invalid++;
        continue;
      }

      // 1. Claim ownership.
      if (dryRun) {
        console.log(`  would claim "${slug}" → org=${organizationId}`);
        stats.claimed++;
      } else {
        try {
          await orgSites.claimSite({
            slug,
            organizationId,
            source: "deco-import",
            by: ACTOR,
          });
          stats.claimed++;
        } catch (err) {
          if (err instanceof OrgSiteConflictError) {
            console.error(
              `  CONFLICT: "${slug}" already owned by org=${err.ownerOrganizationId} (requested org=${organizationId})`,
            );
            stats.conflicts++;
            continue;
          }
          console.error(`  claim "${slug}" failed:`, err);
          continue;
        }
      }

      // 2. Ensure a managed file config for the slug.
      const configName = `${FILE_CONFIG_NAME_PREFIX}${site.name}`;
      const descriptor = tenantStorageDescriptor(slug);
      const existing = await orgFileConfigs.list(organizationId);
      const match = existing.find(
        (c) => c.name.toLowerCase() === configName.toLowerCase(),
      );

      if (match?.credentialType === "managed") {
        stats.skipped++;
        continue;
      }

      if (match) {
        // Convert a legacy sts-session (admin bridge) config to managed —
        // storage fields included, since the legacy row points at the OLD
        // assets bucket while the STS session policy only ever grants
        // `<tenantBucket>/<slug>/*`.
        if (dryRun) {
          console.log(`  would convert config "${configName}" → managed`);
        } else {
          await orgFileConfigs.update({
            id: match.id,
            organizationId,
            bucket: descriptor.bucket,
            region: descriptor.region,
            endpoint: descriptor.endpoint,
            forcePathStyle: descriptor.forcePathStyle,
            prefix: descriptor.prefix,
            publicUrlBase: descriptor.publicUrlBase,
            siteSlug: slug,
            refreshUrl: null,
            credentials: { type: "managed" },
            updatedBy: ACTOR,
          });
        }
        stats.configsConverted++;
        continue;
      }

      // No config yet — create one from the managed tenant descriptor.
      if (dryRun) {
        console.log(`  would create managed config "${configName}"`);
      } else {
        await orgFileConfigs.create({
          organizationId,
          name: configName,
          description: `Managed deco-assets storage for site "${site.name}".`,
          bucket: descriptor.bucket,
          region: descriptor.region,
          endpoint: descriptor.endpoint,
          forcePathStyle: descriptor.forcePathStyle,
          prefix: descriptor.prefix,
          publicUrlBase: descriptor.publicUrlBase,
          refreshUrl: null,
          siteSlug: slug,
          credentials: { type: "managed" },
          createdBy: ACTOR,
        });
      }
      stats.configsCreated++;
    }
  }

  await db.destroy();

  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Done.`);
  console.log(JSON.stringify(stats, null, 2));
  if (stats.conflicts > 0) {
    console.log(
      `\n⚠️  ${stats.conflicts} slug conflict(s) — a different org already owns those slugs. Resolve manually.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
