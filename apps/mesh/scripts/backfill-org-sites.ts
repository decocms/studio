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
 * Run (from apps/mesh):
 *   DATABASE_URL=... ENCRYPTION_KEY=... \
 *   DECO_SUPABASE_URL=... DECO_SUPABASE_SERVICE_KEY=... \
 *   bun run scripts/backfill-org-sites.ts [--dry-run] [--mapping=<path.json>]
 *
 * --dry-run         report what would change without writing.
 * --mapping=<path>  load the mapping from a JSON file [{decoTeamId, organizationId}]
 *                   instead of the inline MAPPING below.
 */

import { readFileSync } from "node:fs";
import { createDatabase } from "../src/database";
import { CredentialVault } from "../src/encryption/credential-vault";
import { tenantStorageDescriptor } from "../src/file-storage/tenant-credentials";
import { getSettings } from "../src/settings";
import { OrgFileConfigStorage } from "../src/storage/org-file-configs";
import { OrgSiteConflictError, OrgSiteStorage } from "../src/storage/org-sites";
import { isValidSiteSlug } from "../src/shared/site-slug";

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
  id: number;
  name: string;
}

async function fetchTeamSites(
  supabaseUrl: string,
  serviceKey: string,
  teamId: number,
): Promise<AdminSite[]> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/sites?team=eq.${teamId}&select=id,name&order=id`,
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const settings = getSettings();

  const supabaseUrl = settings.decoSupabaseUrl;
  const serviceKey = settings.decoSupabaseServiceKey;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "DECO_SUPABASE_URL and DECO_SUPABASE_SERVICE_KEY are required",
    );
  }
  if (!settings.encryptionKey) {
    throw new Error("ENCRYPTION_KEY is required to write managed file configs");
  }

  const mapping = loadMapping();
  if (mapping.length === 0) {
    console.log(
      "No mappings configured. Edit MAPPING in this script or pass --mapping=<path.json>.",
    );
    return;
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
            decoTeamId,
            decoSiteId: site.id,
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
      const existing = await orgFileConfigs.list(organizationId);
      const match = existing.find(
        (c) => c.name.toLowerCase() === configName.toLowerCase(),
      );

      if (match?.credentialType === "managed") {
        stats.skipped++;
        continue;
      }

      if (match) {
        // Convert a legacy sts-session (admin bridge) config to managed.
        if (dryRun) {
          console.log(`  would convert config "${configName}" → managed`);
        } else {
          await orgFileConfigs.update({
            id: match.id,
            organizationId,
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
      const descriptor = tenantStorageDescriptor(slug);
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
