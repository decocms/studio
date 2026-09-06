/**
 * Import legacy deco admin (deco.cx) teams into Studio.
 *
 * For every admin team that owns at least one site, this script:
 *   1. ensures a system user (owner of imported orgs, inviter on invitation rows)
 *   2. resolves or creates the Studio organization, persisting the team↔org
 *      link in `organization.metadata.decoTeamId` (ends the hand-maintained
 *      mapping era of backfill-org-sites.ts)
 *   3. writes long-lived (1 year) SILENT invitation rows for every legacy team
 *      member — no email is sent; the pending invite both suppresses the
 *      personal auto-org on first signup (see ensure-user-organization.ts) and
 *      surfaces the accept screen in the web UI
 *   4. creates one project agent (Virtual MCP) per site, provisioning a
 *      repo-scoped GitHub child connection when DECO_GITHUB_MCP_TOKEN (the deco
 *      machine account's user-to-server grant) is set: MINT_REPO_TOKEN on the
 *      deco/mcp-github server returns a REFRESHABLE repo grant (see
 *      github-repo-scope.ts) persisted in downstream_tokens — the client org
 *      only ever holds a token scoped to its own repo, the managed-assets model
 *      applied to GitHub. Repos whose owner has no installation visible to the
 *      machine account (sites hosted outside deco-sites) fall back to an
 *      UNCONNECTED `metadata.githubRepo`, completed later by the first real
 *      user's GitHub OAuth via the existing web provisioning flow
 *   5. emits a mapping JSON consumable by `scripts/backfill-org-sites.ts
 *      --mapping=<path>`, which handles org_sites claims + managed file configs
 *
 * Org resolution order (first hit wins), per team:
 *   a. an org whose metadata.decoTeamId matches (idempotent re-runs)
 *   b. the single org already owning one of the team's slugs in org_sites
 *      (>1 distinct owners → team skipped, resolve manually)
 *   c. an org with the same slug AND at least one member email in common
 *   d. create a new org via Better Auth (canonical boundary: seedOrgDb,
 *      reserved-slug rejection and billing hooks all run), owned by the system
 *      user; imported orgs are marked `organization_billing.legacy = true`
 *      unless --no-legacy is passed
 *
 * Run (from apps/api) with production env (DATABASE_URL, ENCRYPTION_KEY, the
 * Better Auth env, and DECO_SUPABASE_URL / DECO_SUPABASE_SERVICE_KEY):
 *
 *   bun run scripts/import-deco-teams.ts [--dry-run] [--teams=1,2,3] \
 *     [--mapping-out=team-org-mapping.json] [--no-legacy]
 *
 * --dry-run        report everything without writing.
 * --teams=<ids>    only import these admin team ids (pilot runs).
 * --mapping-out    where to write the backfill-org-sites mapping JSON.
 * --no-legacy      don't flag newly created orgs as billing-legacy.
 *
 * Safe to re-run: every step checks existing state before writing.
 */

import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sql } from "kysely";
import { auth } from "../src/auth";
import type { AuthOrganizationApi } from "../src/auth/ensure-user-organization";
import { closeDatabase, createDatabase } from "../src/database";
import { CredentialVault } from "../src/encryption/credential-vault";
import { getSettings } from "../src/settings";
import { ConnectionStorage } from "../src/storage/connection";
import { DownstreamTokenStorage } from "../src/storage/downstream-token";
import { VirtualMCPStorage } from "../src/storage/virtual";
import { fetchToolsFromMCP } from "../src/tools/connection/fetch-tools";
import {
  GITHUB_SCOPED_PERMISSIONS,
  mintRepoTokenWithChecksFallback,
} from "@decocms/shared/github-repo-scope";
import {
  pickProductionDomain,
  productionUrlFromDomain,
} from "@decocms/shared/deco-site-production-url";
import { resolveDecoSiteGithubRepo } from "@decocms/shared/deco-sites-github";
import { isValidSiteSlug } from "@decocms/shared/site-slug";

const SYSTEM_USER_EMAIL = "imports@deco.cx";
const SYSTEM_USER_NAME = "deco Importer";
const INVITE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const GHS_FALLBACK_LIFETIME_MS = 55 * 60 * 1000;
const DEFAULT_GITHUB_MCP_URL = "https://github-mcp.decocms.com/mcp";

interface AdminTeam {
  id: number;
  slug: string;
  name: string | null;
}

interface AdminSite {
  id: number;
  name: string;
  team: number | null;
  github_repo_url: string | null;
  metadata: unknown;
  domains: { domain: string; production: boolean }[] | null;
}

interface AdminMember {
  user_id: string;
  team_id: number;
  admin: boolean | null;
}

interface AdminProfile {
  user_id: string;
  email: string | null;
}

async function fetchAll<T>(
  supabaseUrl: string,
  serviceKey: string,
  pathWithSelect: string,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/${pathWithSelect}&limit=${limit}&offset=${offset}`,
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
      throw new Error(`admin fetch ${pathWithSelect} (${res.status}): ${text}`);
    }
    const page = (await res.json()) as T[];
    rows.push(...page);
    if (page.length < limit) return rows;
    offset += limit;
  }
}

/** Parse a github.com URL into an owner/name ref, or null. */
function parseRepoUrl(
  url: string | null,
): { owner: string; name: string; url: string } | null {
  if (!url) return null;
  const m = /github\.com\/([^/]+)\/([^/?#]+)/.exec(url);
  if (!m?.[1] || !m[2]) return null;
  const owner = m[1];
  const name = m[2].replace(/\.git$/, "");
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}

function normalizeOrgSlug(raw: string, teamId: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return slug || `team-${teamId}`;
}

/** installation login (lowercased) → installationId, as seen by the machine account. */
async function listGithubInstallations(
  token: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub /user/installations failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      installations: Array<{ id: number; account: { login: string } }>;
    };
    for (const inst of data.installations) {
      map.set(inst.account.login.toLowerCase(), inst.id);
    }
    if (data.installations.length < 100) return map;
    page++;
  }
}

interface MintResult {
  isError?: boolean;
  structuredContent?: {
    token?: string;
    expiresAt?: string;
    refreshToken?: string;
    tokenEndpoint?: string;
    clientId?: string;
    scope?: string;
    repository?: { id?: unknown };
  };
  content?: Array<{ type?: string; text?: string }>;
}

/** Accepts either a JSON string (organization.metadata) or a jsonb object. */
function parseOrgMetadata(metadata: unknown): Record<string, unknown> {
  let parsed = metadata;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return {};
    }
  }
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {};
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const noLegacy = process.argv.includes("--no-legacy");
  const teamsArg = process.argv.find((a) => a.startsWith("--teams="));
  const onlyTeams = teamsArg
    ? new Set(teamsArg.slice("--teams=".length).split(",").map(Number))
    : null;
  const mappingOut =
    process.argv
      .find((a) => a.startsWith("--mapping-out="))
      ?.slice("--mapping-out=".length) ?? "team-org-mapping.json";

  const settings = getSettings();
  const supabaseUrl = settings.decoSupabaseUrl;
  const serviceKey = settings.decoSupabaseServiceKey;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "DECO_SUPABASE_URL and DECO_SUPABASE_SERVICE_KEY are required",
    );
  }

  console.log(`${dryRun ? "[DRY RUN] " : ""}Fetching admin data...`);
  const [teams, sites, adminMembers, profiles] = await Promise.all([
    fetchAll<AdminTeam>(supabaseUrl, serviceKey, "teams?select=id,slug,name"),
    fetchAll<AdminSite>(
      supabaseUrl,
      serviceKey,
      "sites?select=id,name,team,github_repo_url,metadata,domains",
    ),
    fetchAll<AdminMember>(
      supabaseUrl,
      serviceKey,
      "members?select=user_id,team_id,admin&deleted_at=is.null",
    ),
    fetchAll<AdminProfile>(
      supabaseUrl,
      serviceKey,
      "profiles?select=user_id,email",
    ),
  ]);

  const sitesByTeam = new Map<number, AdminSite[]>();
  for (const site of sites) {
    if (site.team === null) continue;
    const list = sitesByTeam.get(site.team) ?? [];
    list.push(site);
    sitesByTeam.set(site.team, list);
  }

  const emailByAdminUser = new Map<string, string>();
  for (const p of profiles) {
    const email = p.email?.trim().toLowerCase();
    if (email?.includes("@")) emailByAdminUser.set(p.user_id, email);
  }

  const membersByTeam = new Map<number, { email: string; admin: boolean }[]>();
  for (const m of adminMembers) {
    const email = emailByAdminUser.get(m.user_id);
    if (!email) continue;
    const list = membersByTeam.get(m.team_id) ?? [];
    list.push({ email, admin: m.admin === true });
    membersByTeam.set(m.team_id, list);
  }

  const scopedTeams = teams.filter(
    (t) => sitesByTeam.has(t.id) && (!onlyTeams || onlyTeams.has(t.id)),
  );
  console.log(
    `${scopedTeams.length} team(s) in scope (${sites.length} sites total).`,
  );

  const database = createDatabase(settings.databaseUrl);
  const db = database.db;
  const virtualMcps = new VirtualMCPStorage(db);
  const vault = new CredentialVault(settings.encryptionKey);
  const connections = new ConnectionStorage(db, vault);
  const downstreamTokens = new DownstreamTokenStorage(db, vault);
  // Same structural contract ensureUserOrganization consumes for auth.api.
  const orgApi = auth.api as unknown as AuthOrganizationApi;

  // Machine-account grant for eager repo-scoped GitHub provisioning. Absent →
  // every agent is created unconnected (lazy path).
  const githubToken = process.env.DECO_GITHUB_MCP_TOKEN ?? null;
  const githubMcpUrl =
    process.env.DECO_GITHUB_MCP_URL ?? DEFAULT_GITHUB_MCP_URL;
  let installations = new Map<string, number>();
  let githubMcp: Client | null = null;
  if (githubToken) {
    installations = await listGithubInstallations(githubToken);
    console.log(
      `machine account sees ${installations.size} GitHub installation(s): ${[...installations.keys()].join(", ")}`,
    );
    githubMcp = new Client({ name: "import-deco-teams", version: "1.0.0" });
    await githubMcp.connect(
      new StreamableHTTPClientTransport(new URL(githubMcpUrl), {
        requestInit: {
          headers: { Authorization: `Bearer ${githubToken}` },
        },
      }),
    );
  } else {
    console.warn(
      "DECO_GITHUB_MCP_TOKEN not set — all agents will be created with GitHub unconnected",
    );
  }

  // ---- Studio state (loaded once; kept in memory for idempotency checks) ----
  const orgs = await db
    .selectFrom("organization")
    .select(["id", "slug", "name", "metadata"])
    .execute();
  const orgByTeamId = new Map<number, string>();
  const orgBySlug = new Map<string, { id: string; metadata: string | null }>();
  for (const org of orgs) {
    orgBySlug.set(org.slug, org);
    const teamId = parseOrgMetadata(org.metadata).decoTeamId;
    if (typeof teamId === "number") orgByTeamId.set(teamId, org.id);
  }

  const memberRows = await db
    .selectFrom("member")
    .innerJoin("user", "user.id", "member.userId")
    .select(["member.organizationId as orgId", "user.email as email"])
    .execute();
  const orgMemberEmails = new Map<string, Set<string>>();
  for (const row of memberRows) {
    const set = orgMemberEmails.get(row.orgId) ?? new Set();
    set.add(row.email.toLowerCase());
    orgMemberEmails.set(row.orgId, set);
  }

  const orgSiteRows = await db
    .selectFrom("org_sites")
    .select(["slug", "organization_id"])
    .execute();
  const orgBySiteSlug = new Map(
    orgSiteRows.map((r) => [r.slug, r.organization_id]),
  );

  const pendingInvites = await sql<{ email: string; organizationId: string }>`
    select lower(email) as email, "organizationId"
      from invitation
     where status = 'pending' and "expiresAt" > now()
  `.execute(db);
  const invitedKeys = new Set(
    pendingInvites.rows.map((r) => `${r.organizationId}:${r.email}`),
  );

  const virtualRows = await db
    .selectFrom("connections")
    .select(["organization_id", "metadata"])
    .where("connection_type", "=", "VIRTUAL")
    .where("metadata", "is not", null)
    .execute();
  const agentSiteKeys = new Set<string>();
  for (const row of virtualRows) {
    const slug = parseOrgMetadata(row.metadata).siteSlug;
    if (typeof slug === "string") {
      agentSiteKeys.add(`${row.organization_id}:${slug}`);
    }
  }

  // Existing repo-scoped GitHub children, keyed `${orgId}:${owner}/${repo}`.
  const repoChildRows = await db
    .selectFrom("connections")
    .select(["id", "organization_id", "metadata"])
    .where("connection_type", "=", "HTTP")
    .where("metadata", "is not", null)
    .execute();
  const repoChildByKey = new Map<string, string>();
  for (const row of repoChildRows) {
    const scope = parseOrgMetadata(row.metadata).repoScope as
      | { owner?: string; repo?: string }
      | undefined;
    if (scope?.owner && scope?.repo) {
      repoChildByKey.set(
        `${row.organization_id}:${scope.owner.toLowerCase()}/${scope.repo.toLowerCase()}`,
        row.id,
      );
    }
  }

  // ---- 1. System user ----------------------------------------------------
  // Inserted directly (not via signUpEmail): no account row means no login
  // path, and skipping the user.create hook avoids a personal auto-org.
  let systemUserId: string;
  const existingSystemUser = await db
    .selectFrom("user")
    .select("id")
    .where(sql`lower(email)`, "=", SYSTEM_USER_EMAIL)
    .executeTakeFirst();
  if (existingSystemUser) {
    systemUserId = existingSystemUser.id;
  } else if (dryRun) {
    systemUserId = "would-create-system-user";
    console.log(`would create system user ${SYSTEM_USER_EMAIL}`);
  } else {
    systemUserId = crypto.randomUUID();
    await sql`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${systemUserId}, ${SYSTEM_USER_NAME}, ${SYSTEM_USER_EMAIL}, true, now(), now())
    `.execute(db);
    console.log(`created system user ${SYSTEM_USER_EMAIL} (${systemUserId})`);
  }

  const stats = {
    orgsMatched: 0,
    orgsCreated: 0,
    teamsSkipped: 0,
    invitesCreated: 0,
    invitesSkipped: 0,
    agentsCreated: 0,
    agentsConnected: 0,
    agentsLazy: 0,
    agentsSkipped: 0,
  };
  const mapping: { decoTeamId: number; organizationId: string }[] = [];

  /**
   * Mint a refreshable repo grant with the machine account and materialize it
   * as a repo-scoped child connection in the client org — the client only ever
   * holds a token scoped to its own repo (managed-assets model). Returns the
   * child connection id, or the pre-existing one for this org+repo.
   */
  const provisionRepoChild = async (
    orgId: string,
    repo: { owner: string; name: string; url: string },
    installationId: number,
  ): Promise<string | null> => {
    const key = `${orgId}:${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
    const existing = repoChildByKey.get(key);
    if (existing) return existing;
    if (!githubMcp) return null;

    const { result, grantedPermissions } =
      await mintRepoTokenWithChecksFallback<MintResult>(
        (permissions) =>
          githubMcp.callTool({
            name: "MINT_REPO_TOKEN",
            arguments: {
              installationId,
              owner: repo.owner,
              repo: repo.name,
              permissions,
            },
          }) as unknown as Promise<MintResult>,
        GITHUB_SCOPED_PERMISSIONS,
      );
    const minted = result.structuredContent;
    if (result.isError || !minted?.token) {
      const detail = result.content?.find((c) => c.type === "text")?.text;
      throw new Error(detail ?? "MINT_REPO_TOKEN failed");
    }
    if (!minted.refreshToken || !minted.tokenEndpoint || !minted.clientId) {
      throw new Error("mint result missing refreshable grant metadata");
    }
    const repositoryId =
      typeof minted.repository?.id === "number" &&
      Number.isInteger(minted.repository.id) &&
      minted.repository.id > 0
        ? minted.repository.id
        : undefined;

    const title = `GitHub: ${repo.owner}/${repo.name}`;
    // Populate the tools list at save time, mirroring COLLECTION_CONNECTIONS_CREATE.
    const fetched = await fetchToolsFromMCP({
      id: "pending-import",
      title,
      connection_type: "HTTP",
      connection_url: githubMcpUrl,
      connection_token: minted.token,
    }).catch(() => null);

    const child = await connections.create({
      organization_id: orgId,
      created_by: systemUserId,
      title,
      description: `Repo-scoped GitHub access for ${repo.owner}/${repo.name}`,
      app_name: "mcp-github",
      connection_type: "HTTP",
      connection_url: githubMcpUrl,
      tools: fetched?.tools ?? null,
      configuration_scopes: fetched?.scopes ?? null,
      metadata: {
        repoScope: {
          installationId,
          repositoryId,
          owner: repo.owner,
          repo: repo.name,
          permissions: grantedPermissions,
          grantProvider: "github-mcp",
        },
      },
    });
    await downstreamTokens.upsert({
      connectionId: child.id,
      accessToken: minted.token,
      refreshToken: minted.refreshToken,
      scope: minted.scope ?? null,
      expiresAt: minted.expiresAt
        ? new Date(minted.expiresAt)
        : new Date(Date.now() + GHS_FALLBACK_LIFETIME_MS),
      clientId: minted.clientId,
      clientSecret: null,
      tokenEndpoint: minted.tokenEndpoint,
    });
    repoChildByKey.set(key, child.id);
    return child.id;
  };

  const stampTeamId = async (orgId: string, teamId: number) => {
    const org = orgs.find((o) => o.id === orgId);
    const meta = parseOrgMetadata(org?.metadata ?? null);
    if (meta.decoTeamId === teamId) return;
    meta.decoTeamId = teamId;
    meta.importedFrom ??= "deco-admin";
    if (!dryRun) {
      await db
        .updateTable("organization")
        .set({ metadata: JSON.stringify(meta) })
        .where("id", "=", orgId)
        .execute();
    }
  };

  for (const team of scopedTeams) {
    const teamSites = sitesByTeam.get(team.id) ?? [];
    const teamMembers = membersByTeam.get(team.id) ?? [];
    const teamEmails = new Set(teamMembers.map((m) => m.email));

    // ---- 2. Resolve or create the org ------------------------------------
    let orgId = orgByTeamId.get(team.id) ?? null;

    if (!orgId) {
      const owners = new Set(
        teamSites
          .map((s) => orgBySiteSlug.get(s.name.toLowerCase()))
          .filter((o): o is string => Boolean(o)),
      );
      if (owners.size > 1) {
        console.warn(
          `  SKIP team=${team.id} "${team.slug}": sites already claimed by ${owners.size} different orgs — resolve manually`,
        );
        stats.teamsSkipped++;
        continue;
      }
      if (owners.size === 1) {
        orgId = [...owners][0]!;
        await stampTeamId(orgId, team.id);
        stats.orgsMatched++;
      }
    }

    if (!orgId) {
      const slugMatch = orgBySlug.get(team.slug);
      if (slugMatch) {
        const overlap = [...(orgMemberEmails.get(slugMatch.id) ?? [])].some(
          (email) => teamEmails.has(email),
        );
        if (overlap) {
          orgId = slugMatch.id;
          await stampTeamId(orgId, team.id);
          stats.orgsMatched++;
        }
      }
    }

    if (!orgId) {
      const base = normalizeOrgSlug(team.slug, team.id);
      const candidates = [
        base,
        normalizeOrgSlug(`${base}-${team.id}`, team.id),
      ];
      if (dryRun) {
        console.log(
          `  would create org "${team.name ?? team.slug}" (slug≈${base}) for team=${team.id}`,
        );
        orgId = `would-create-org-${team.id}`;
        stats.orgsCreated++;
      } else {
        let lastError: unknown;
        for (const slug of candidates) {
          if (orgBySlug.has(slug)) continue;
          try {
            const created = (await orgApi.createOrganization({
              body: {
                name: team.name?.trim() || team.slug,
                slug,
                userId: systemUserId,
              },
            })) as { id?: string } | null;
            if (created?.id) {
              orgId = created.id;
              orgs.push({
                id: orgId,
                slug,
                name: team.name ?? team.slug,
                metadata: null,
              });
              orgBySlug.set(slug, { id: orgId, metadata: null });
              break;
            }
          } catch (err) {
            lastError = err;
          }
        }
        if (!orgId) {
          console.error(
            `  FAILED to create org for team=${team.id}:`,
            lastError,
          );
          stats.teamsSkipped++;
          continue;
        }
        await stampTeamId(orgId, team.id);
        if (!noLegacy) {
          // seedOrgDb marks fresh orgs legacy=false; imported legacy-platform
          // customers keep the pre-per-seat billing treatment.
          await db
            .insertInto("organization_billing")
            .values({ organization_id: orgId, legacy: true })
            .onConflict((oc) =>
              oc.column("organization_id").doUpdateSet({ legacy: true }),
            )
            .execute();
        }
        stats.orgsCreated++;
        console.log(
          `  created org ${orgId} for team=${team.id} "${team.slug}"`,
        );
      }
      orgByTeamId.set(team.id, orgId);
    }

    mapping.push({ decoTeamId: team.id, organizationId: orgId });

    // ---- 3. Silent long-lived invitations ---------------------------------
    const memberEmails = orgMemberEmails.get(orgId) ?? new Set<string>();
    const seen = new Set<string>();
    for (const member of teamMembers) {
      if (seen.has(member.email)) continue;
      seen.add(member.email);
      if (
        member.email === SYSTEM_USER_EMAIL ||
        memberEmails.has(member.email) ||
        invitedKeys.has(`${orgId}:${member.email}`)
      ) {
        stats.invitesSkipped++;
        continue;
      }
      invitedKeys.add(`${orgId}:${member.email}`);
      stats.invitesCreated++;
      if (dryRun) continue;
      const role = member.admin ? "admin" : "user";
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      await sql`
        insert into invitation
          (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId")
        values
          (${crypto.randomUUID()}, ${orgId}, ${member.email}, ${role}, 'pending',
           ${expiresAt}, now(), ${systemUserId})
      `.execute(db);
    }

    // ---- 4. One project agent per site -------------------------------------
    for (const site of teamSites) {
      const siteSlug = site.name.toLowerCase();
      if (agentSiteKeys.has(`${orgId}:${siteSlug}`)) {
        stats.agentsSkipped++;
        continue;
      }
      agentSiteKeys.add(`${orgId}:${siteSlug}`);
      const repo =
        parseRepoUrl(site.github_repo_url) ??
        resolveDecoSiteGithubRepo(site.name, site.metadata);
      const installationId =
        installations.get(repo.owner.toLowerCase()) ?? null;

      if (dryRun) {
        stats.agentsCreated++;
        if (installationId && githubMcp) stats.agentsConnected++;
        else stats.agentsLazy++;
        continue;
      }

      let childConnectionId: string | null = null;
      if (installationId) {
        try {
          childConnectionId = await provisionRepoChild(
            orgId,
            repo,
            installationId,
          );
        } catch (err) {
          console.warn(
            `  mint failed for ${repo.owner}/${repo.name} (org=${orgId}) — creating unconnected: ${(err as Error).message}`,
          );
        }
      }

      await virtualMcps.create(orgId, systemUserId, {
        title: site.name,
        description: "Imported from deco.cx",
        icon: null,
        pinned: false,
        status: "active",
        metadata: {
          instructions: null,
          enabled_plugins: [],
          siteSlug: isValidSiteSlug(siteSlug) ? siteSlug : null,
          productionUrl: productionUrlFromDomain(
            pickProductionDomain(site.domains),
          ),
          githubRepo: {
            owner: repo.owner,
            name: repo.name,
            url: repo.url,
            ...(childConnectionId && installationId
              ? { installationId, connectionId: childConnectionId }
              : {}),
          },
          ui: {
            layout: {
              defaultMainView: { type: "preview" },
              chatDefaultOpen: true,
            },
          },
        },
        connections: childConnectionId
          ? [{ connection_id: childConnectionId }]
          : [],
      });
      stats.agentsCreated++;
      if (childConnectionId) stats.agentsConnected++;
      else stats.agentsLazy++;
    }
  }

  writeFileSync(mappingOut, JSON.stringify(mapping, null, 2));
  console.log(
    `\n${dryRun ? "[DRY RUN] " : ""}Done. Mapping for backfill-org-sites.ts written to ${mappingOut}`,
  );
  console.log(JSON.stringify(stats, null, 2));
  console.log(
    "\nNext: bun run scripts/backfill-org-sites.ts --mapping=" + mappingOut,
  );

  await githubMcp?.close().catch(() => {});
  await closeDatabase(database);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
