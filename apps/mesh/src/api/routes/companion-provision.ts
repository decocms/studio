/**
 * Companion provisioning — turns a `deco link` identity into ready-to-use MCP
 * entries for the local companion app.
 *
 * The companion desktop app authenticates with the SAME link/tunnel bearer the
 * `deco link` daemon uses (an OAuth MCP session token). That token is a narrow
 * *identity* credential — it cannot drive management tools (ORGANIZATION_LIST /
 * API_KEY_CREATE) over the public MCP endpoints. So the app can't enumerate
 * orgs or mint per-org keys itself. This module does it server-side, keyed off
 * the resolved userId (see `resolveLinkBearer`): it lists the user's orgs and
 * mints one API key per org, returning the exact `{url, key}` the app writes
 * into `~/.claude.json` under `mcpServers`.
 *
 * TARGET — the org's self/management MCP, not Decopilot:
 * The URL points at `/api/<slug>/mcp/self` (`createSelfRoutes` — "the MCP for
 * the CMS API", the org's own default `@deco/management-mcp` connection). That
 * is the endpoint that actually exposes the org's tools to an MCP client. The
 * Decopilot virtual-MCP (`/mcp/virtual-mcp/decopilot_<orgId>`) is a pure
 * orchestrator with `connections: []` (see `storage/virtual.ts` findById), so
 * an external client connecting there gets an EMPTY tool list — it drives runs,
 * it is not a tool surface.
 *
 * Key SCOPE — `{ self: ["*"] }`, and why only for admins:
 * Self-MCP tools are authorized against the `"self"` resource key (the default
 * `connectionId` for management tools). `{ self: ["*"] }` is exactly the scope
 * the org's own default self-connection is minted with (see `seedOrgDb`,
 * auth/org.ts). But an API key is a flat capability that ignores the owner's
 * role, so a wildcard-over-`self` key handed to a non-admin member would let
 * them call every admin tool on that org — a persistent privilege escalation
 * (guarded by apikey-scope-enforcement e2e). We therefore only mint for orgs
 * where the caller is owner/admin (the scope grants nothing their role doesn't
 * already grant) and SKIP the rest, reporting them so the app can explain why.
 * Member support needs a role-carrying credential and is out of scope here.
 *
 * The key mint mirrors `seedOrgDb` (auth/org.ts) and `dev-link-session.ts`:
 * `auth.api.createApiKey` with a `userId` and NO headers is a server-side call
 * (Better Auth then permits server-only `permissions`). Org listing goes
 * straight to the Better Auth `member`/`organization` tables because
 * `auth.api.listOrganizations` is `requireHeaders: true` and always reads the
 * *session* user — unusable from this session-less path.
 */
import { getDb } from "@/database";
import { SELF_MCP_ALIAS_ID } from "@decocms/mesh-sdk";
import { auth } from "../../auth";
import { ADMIN_ROLES } from "../../auth/roles";
import { isOrgArchived } from "../../core/org-archived";

export interface CompanionOrgMcp {
  /** Organization id. */
  id: string;
  /** Immutable org slug (used in the MCP URL path). */
  slug: string;
  /** Human-facing org name. */
  name: string;
  /** Org self/management MCP URL for this org. */
  url: string;
  /** Scoped API key for the Authorization header (returned only once). */
  key: string;
}

export interface CompanionOrgSkipped {
  id: string;
  slug: string;
  name: string;
  /** Machine-readable reason the app can surface. */
  reason: "requires-elevated-role" | "provisioning-failed";
}

export interface CompanionProvisionResult {
  orgs: CompanionOrgMcp[];
  skipped: CompanionOrgSkipped[];
}

/**
 * The org self/management MCP URL. Pure/deterministic — the app writes this as
 * the `url` of the `deco-<slug>` server entry. `/mcp/self` (SELF_MCP_ALIAS_ID)
 * is the org-scoped management MCP that exposes the org's tools.
 */
export function companionMcpUrl(studioUrl: string, orgSlug: string): string {
  return new URL(`/api/${orgSlug}/mcp/${SELF_MCP_ALIAS_ID}`, studioUrl).href;
}

/** 90 days — long enough to survive normal use; re-minted on re-provision. */
const COMPANION_KEY_EXPIRES_IN = 60 * 60 * 24 * 90;

/** Stable per-org key name; also the handle we revoke stale keys by. */
const companionKeyName = (orgSlug: string) => `companion-${orgSlug}`;

interface UserOrgRow {
  id: string;
  name: string;
  slug: string;
  role: string | null;
  metadata: string | null;
}

/**
 * Organizations the user belongs to, with their membership role (archived orgs
 * filtered out — the same choke point `boundAuth.organization.list` and
 * `getExistingUserOrganization` apply). Reads the Better Auth membership tables
 * directly.
 */
async function listUserOrgs(userId: string): Promise<UserOrgRow[]> {
  const rows = await getDb()
    .db.selectFrom("member")
    .innerJoin("organization", "organization.id", "member.organizationId")
    .select([
      "organization.id as id",
      "organization.name as name",
      "organization.slug as slug",
      "member.role as role",
      "organization.metadata as metadata",
    ])
    .where("member.userId", "=", userId)
    .orderBy("member.createdAt", "asc")
    .execute();
  return rows.filter((org) => !isOrgArchived(org));
}

/**
 * True if any of the member's roles is a built-in admin role. Better Auth
 * stores multi-role membership as a comma-separated string; a custom role is
 * treated as non-admin (safe default — we only auto-grant the wildcard where
 * the role provably already grants everything).
 */
export function isAdminRole(role: string | null): boolean {
  if (!role) return false;
  const roles = role.split(",").map((r) => r.trim());
  return roles.some((r) => (ADMIN_ROLES as string[]).includes(r));
}

/**
 * Revoke this user's prior companion key for an org before minting a fresh one,
 * so repeated launches don't accumulate live 90-day keys. Keyed by (userId,
 * name) — the name is our namespace, so this never touches a key we didn't
 * mint. Table name `apikey` matches Better Auth's default (not in the typed
 * Kysely interface — same `as any` as the expired-key sweep in app.ts).
 */
async function revokePriorCompanionKey(
  userId: string,
  orgSlug: string,
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: Better Auth `apikey` table isn't in the typed Database interface.
  const db = getDb().db as any;
  await db
    .deleteFrom("apikey")
    .where("userId", "=", userId)
    .where("name", "=", companionKeyName(orgSlug))
    .execute();
}

/**
 * List the user's orgs and mint one API key per org the caller is owner/admin
 * of (see the module header for the scope rationale). Orgs where the caller
 * lacks an admin role — or whose mint fails — are returned in `skipped` so the
 * app can report them instead of silently dropping them.
 *
 * Each call mints fresh keys (an API key value is only returned at creation and
 * cannot be read back), revoking the prior companion key for the org first.
 */
export async function provisionCompanionMcps(
  userId: string,
  studioUrl: string,
): Promise<CompanionProvisionResult> {
  const orgs = await listUserOrgs(userId);
  const provisioned: CompanionOrgMcp[] = [];
  const skipped: CompanionOrgSkipped[] = [];

  for (const org of orgs) {
    if (!isAdminRole(org.role)) {
      skipped.push({
        id: org.id,
        slug: org.slug,
        name: org.name,
        reason: "requires-elevated-role",
      });
      continue;
    }

    try {
      await revokePriorCompanionKey(userId, org.slug);
      const created = (await auth.api.createApiKey({
        body: {
          name: companionKeyName(org.slug),
          userId,
          // Full access to the org's self/management MCP (tools keyed on the
          // `"self"` resource) — same scope as the org's own default
          // self-connection. Safe here because the caller is owner/admin (see
          // module header).
          permissions: { self: ["*"] },
          expiresIn: COMPANION_KEY_EXPIRES_IN,
          rateLimitEnabled: false,
          metadata: {
            organization: { id: org.id },
            purpose: "companion",
          },
        },
      })) as { key?: string } | null;
      const key = created?.key;
      if (!key) throw new Error("createApiKey returned no key");
      provisioned.push({
        id: org.id,
        slug: org.slug,
        name: org.name,
        url: companionMcpUrl(studioUrl, org.slug),
        key,
      });
    } catch (err) {
      console.error(
        `[companion] provisioning failed for org ${org.slug}:`,
        err instanceof Error ? err.message : String(err),
      );
      skipped.push({
        id: org.id,
        slug: org.slug,
        name: org.name,
        reason: "provisioning-failed",
      });
    }
  }

  return { orgs: provisioned, skipped };
}
