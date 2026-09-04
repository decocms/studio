/**
 * The write gate behind a `block` notice (see `organization_notices`).
 *
 * A blocked organization keeps its data plane — MCP proxy traffic, the vault
 * tokens that traffic mints, the OAuth dance behind it — and loses its control
 * plane: every builtin tool call and every non-GET org-scoped route, except the
 * handful a blocked member still needs to read the notice and pay it.
 *
 * Blocking is an operator action on a delinquent tenant, not access control on
 * a principal, so it is enforced at the two chokepoints every caller passes
 * through rather than woven into permissions: `defineTool`'s execute wrapper
 * and one middleware on the org-scoped router.
 *
 * The lookup is cached per org because that middleware sits on the request hot
 * path. A GET, or a data-plane path, returns before the cache is even read.
 */

import type { Kysely } from "kysely";
import { ForbiddenError } from "./access-control";
import { OrganizationNoticeStorage } from "../storage/organization-notices";
import type { Database, OrganizationNotice } from "../storage/types";

/**
 * A notice is set by a human in the admin UI and read on nearly every request,
 * so staleness costs a few minutes of enforcement while freshness would cost a
 * query per request. The admin write drops its own instance's entry, making the
 * window matter only for other pods in a multi-instance deployment.
 */
const ORG_NOTICE_CACHE_TTL_MS = 5 * 60_000;

const orgNoticeCache = new Map<
  string,
  { notice: OrganizationNotice | null; at: number }
>();

/** Thrown when a blocked org's control plane is touched. Serialized as 403. */
export class OrgBlockedError extends ForbiddenError {
  readonly code = "org_blocked";

  constructor(message: string) {
    super(message);
    this.name = "OrgBlockedError";
  }
}

/**
 * The org's live notice, cached. Returns null both for "no notice" and for an
 * org that does not exist — neither is blocked.
 */
export async function getActiveOrgNoticeCached(
  db: Kysely<Database>,
  organizationId: string,
): Promise<OrganizationNotice | null> {
  const hit = orgNoticeCache.get(organizationId);
  if (hit && Date.now() - hit.at < ORG_NOTICE_CACHE_TTL_MS) return hit.notice;
  const notice = await new OrganizationNoticeStorage(db).getActive(
    organizationId,
  );
  orgNoticeCache.set(organizationId, { notice, at: Date.now() });
  return notice;
}

/** Drop one org's cached notice, so this instance enforces a write at once. */
export function invalidateOrgNoticeCache(organizationId: string): void {
  orgNoticeCache.delete(organizationId);
}

export async function isOrgBlocked(
  db: Kysely<Database>,
  organizationId: string,
): Promise<boolean> {
  const notice = await getActiveOrgNoticeCached(db, organizationId);
  return notice?.severity === "block";
}

/**
 * Tools a member of a blocked org may still call: what the shell reads to
 * render the block screen, plus the billing surface the screen sends them to.
 * Everything else is denied — an allowlist, because most tools carry no
 * annotation saying whether they write.
 */
const TOOLS_ALLOWED_WHILE_BLOCKED: ReadonlySet<string> = new Set([
  "ORGANIZATION_GET",
  "ORGANIZATION_SETTINGS_GET",
  "ORGANIZATION_BILLING_PORTAL",
  "ORGANIZATION_BILLING_CHECKOUT_START",
  "INFRA_BILLING_GET",
  "INFRA_BILLING_PORTAL",
  "INFRA_BILLING_SITES_LIST",
]);

export function isToolAllowedWhileBlocked(toolName: string): boolean {
  return TOOLS_ALLOWED_WHILE_BLOCKED.has(toolName);
}

/**
 * First path segment under `/api/:org/` whose non-GET requests survive a block.
 *
 * - `tools` is not exempt so much as delegated: the tool gate decides per tool
 *   name, which is finer than this list can be.
 * - `mcp`, `vault`, `connections`, `oauth-proxy` and `sandbox` are the data
 *   plane and the credentials it runs on — a block stops the tenant's team from
 *   changing things, not their users' traffic.
 * - `trigger-callback` completes work already dispatched; refusing it strands a
 *   run rather than preventing one.
 * - `sso` has to work or the member cannot sign in far enough to read why.
 */
const ORG_PATH_PREFIXES_ALLOWED_WHILE_BLOCKED: readonly string[] = [
  "tools",
  "mcp",
  "vault",
  "connections",
  "oauth-proxy",
  "sandbox",
  "trigger-callback",
  "sso",
];

/**
 * Whether one org-scoped request is subject to the block. Pure, so the routing
 * rules are unit-testable without a request. `path` is the full request path
 * (`/api/:org/...`).
 */
export function isBlockableOrgRequest(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return false;
  }
  const segments = path.split("/").filter(Boolean);
  // ["api", "<org>", "<first>", ...] — anything shorter has no route to block.
  const first = segments[2];
  if (!first) return false;
  return !ORG_PATH_PREFIXES_ALLOWED_WHILE_BLOCKED.includes(first);
}
