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
 * mints one Decopilot-scoped API key per org, returning the exact `{url, key}`
 * the app writes into `~/.claude.json` under `mcpServers`.
 *
 * The key mint mirrors `seedOrgDb` (auth/org.ts) and `dev-link-session.ts`:
 * `auth.api.createApiKey` with a `userId` and NO headers is a server-side call
 * (Better Auth then permits server-only `permissions`). Org listing goes
 * straight to the Better Auth `member`/`organization` tables because
 * `auth.api.listOrganizations` is `requireHeaders: true` and always reads the
 * *session* user — unusable from this session-less path.
 */
import { getDb } from "@/database";
import { getDecopilotId } from "@decocms/mesh-sdk";
import { auth } from "../../auth";
import { isOrgArchived } from "../../core/org-archived";

export interface CompanionOrgMcp {
  /** Organization id. */
  id: string;
  /** Immutable org slug (used in the MCP URL path). */
  slug: string;
  /** Human-facing org name. */
  name: string;
  /** Decopilot virtual-MCP URL for this org. */
  url: string;
  /** Scoped API key for the Authorization header (returned only once). */
  key: string;
}

/**
 * The Decopilot virtual-MCP URL for an org. Pure/deterministic — the app
 * writes this as the `url` of the `deco-<slug>` server entry.
 */
export function companionMcpUrl(
  studioUrl: string,
  orgSlug: string,
  orgId: string,
): string {
  return new URL(
    `/api/${orgSlug}/mcp/virtual-mcp/${getDecopilotId(orgId)}`,
    studioUrl,
  ).href;
}

/** 90 days — long enough to survive normal use; re-minted on re-provision. */
const COMPANION_KEY_EXPIRES_IN = 60 * 60 * 24 * 90;

interface UserOrgRow {
  id: string;
  name: string;
  slug: string;
  metadata: string | null;
}

/**
 * Organizations the user belongs to (archived orgs filtered out — the same
 * choke point `boundAuth.organization.list` and `getExistingUserOrganization`
 * apply). Reads the Better Auth membership tables directly.
 */
async function listUserOrgs(userId: string): Promise<UserOrgRow[]> {
  const rows = await getDb()
    .db.selectFrom("member")
    .innerJoin("organization", "organization.id", "member.organizationId")
    .select([
      "organization.id as id",
      "organization.name as name",
      "organization.slug as slug",
      "organization.metadata as metadata",
    ])
    .where("member.userId", "=", userId)
    .orderBy("member.createdAt", "asc")
    .execute();
  return rows.filter((org) => !isOrgArchived(org));
}

/**
 * List the user's orgs and mint one Decopilot-scoped API key per org.
 *
 * Each call mints fresh keys (an API key value is only returned at creation and
 * cannot be read back, so re-provision cannot reuse a prior key). Keys are
 * tagged `metadata.purpose = "companion"` so a future rotation/cleanup pass can
 * find and revoke stale ones — TODO(companion): revoke prior companion keys for
 * (user, org) before minting to avoid key sprawl on repeated launches.
 */
export async function provisionCompanionMcps(
  userId: string,
  studioUrl: string,
): Promise<CompanionOrgMcp[]> {
  const orgs = await listUserOrgs(userId);
  const provisioned: CompanionOrgMcp[] = [];
  for (const org of orgs) {
    const decopilotId = getDecopilotId(org.id);
    const created = (await auth.api.createApiKey({
      body: {
        name: `companion-${org.slug}`,
        userId,
        // Scope to this org's Decopilot agent only.
        permissions: { [decopilotId]: ["*"] },
        expiresIn: COMPANION_KEY_EXPIRES_IN,
        rateLimitEnabled: false,
        metadata: {
          organization: { id: org.id },
          purpose: "companion",
        },
      },
    })) as { key?: string } | null;
    const key = created?.key;
    if (!key) continue;
    provisioned.push({
      id: org.id,
      slug: org.slug,
      name: org.name,
      url: companionMcpUrl(studioUrl, org.slug, org.id),
      key,
    });
  }
  return provisioned;
}
