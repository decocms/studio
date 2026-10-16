/**
 * Resolve the project (Virtual MCP) allowlist for the current caller.
 *
 * A custom role may be scoped to a set of projects via the reserved `projects`
 * key in its stored permission map (see @decocms/shared/auth/project-scope).
 * This resolves that allowlist for the caller so read/list tools can hide, and
 * mutation tools can reject, projects outside it.
 *
 * A member with several roles sees the projects any of them admits.
 *
 * Returns `null` (unrestricted — sees every project) for:
 *   - owner/admin (they bypass all permission checks anyway),
 *   - built-in roles (owner/admin/user have no organizationRole row),
 *   - API-key principals (authorized by their own allowlist, a separate lane),
 *   - any role whose stored permission omits the `projects` key.
 */

import {
  getProjectScope,
  projectScopeFilter,
  unionProjectScopes,
} from "@decocms/shared/auth/project-scope";
import { isScopableProject } from "@decocms/shared/sdk";
import { hasAdminRole, rolesOf } from "@decocms/shared/auth/roles";
import { fetchRolePermissions } from "./context-factory";
import {
  TASK_BOARD_ITEM_DELETED_EVENT,
  TASK_BOARD_ITEM_PRS_UPDATED_EVENT,
  TASK_BOARD_ITEM_UPDATED_EVENT,
} from "@decocms/shared/task-board";
import type { SSEEvent } from "../event-bus/sse-hub";
import type { StudioContext } from "./studio-context";

export async function resolveCallerProjectScope(
  ctx: StudioContext,
): Promise<string[] | null> {
  // API keys are authorized by their own allowlist, not a member role.
  if (ctx.auth.apiKey) {
    return null;
  }

  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    return null;
  }

  // Path-resolved role matches the targeted org; fall back to the session role.
  const role =
    ctx.access.getRole() ?? ctx.organization?.role ?? ctx.auth.user?.role;
  if (!role || hasAdminRole(role)) {
    return null;
  }

  // Reuse the map already resolved at auth time when it's for this org (no requery).
  if (
    ctx.auth.permissions &&
    ctx.auth.permissionsOrganizationId === organizationId
  ) {
    return getProjectScope(ctx.auth.permissions);
  }

  // Built-in roles have no organizationRole row → undefined → unrestricted.
  const scopes = await Promise.all(
    rolesOf(role).map(async (one) =>
      getProjectScope(await fetchRolePermissions(ctx.db, organizationId, one)),
    ),
  );
  return unionProjectScopes(scopes);
}

const NO_HIDDEN_PROJECTS: ReadonlySet<string> = new Set();

/**
 * The org's projects the caller may not see. Lists filter on this rather than
 * on the scope itself, so things filed under an agent that is not a project
 * (or under nothing) stay visible to a role scoped to a few projects.
 */
export async function resolveHiddenProjectIds(
  ctx: StudioContext,
): Promise<ReadonlySet<string>> {
  const filter = projectScopeFilter(await resolveCallerProjectScope(ctx));
  if (filter.kind === "all") return NO_HIDDEN_PROJECTS;
  if (filter.kind === "except") return new Set(filter.names);

  const organizationId = ctx.organization?.id;
  if (!organizationId) return NO_HIDDEN_PROJECTS;
  const allowed = new Set(filter.names);
  const projects = await ctx.storage.virtualMcps.list(organizationId);
  return new Set(
    projects
      .filter((project) => isScopableProject(project))
      .map((project) => project.id)
      .filter((id) => !allowed.has(id)),
  );
}

/** The fields the board attributes a card to a project by. */
interface ProjectAttributedCard {
  virtualMcpId: string | null;
  repo: string | null;
  threads: readonly { virtualMcpId: string | null }[];
}

function isProjectAttributedCard(
  value: unknown,
): value is ProjectAttributedCard {
  if (typeof value !== "object" || value === null) return false;
  const card = value as Record<string, unknown>;
  const optionalString = (field: unknown) =>
    field === null || typeof field === "string";
  return (
    optionalString(card.virtualMcpId) &&
    optionalString(card.repo) &&
    Array.isArray(card.threads) &&
    card.threads.every(
      (thread) =>
        typeof thread === "object" &&
        thread !== null &&
        optionalString((thread as Record<string, unknown>).virtualMcpId),
    )
  );
}

/**
 * Whether a card is visible when `hidden` projects are not. The board
 * attributes a card to a project by its stamp, a linked thread, or a project
 * id older clients wrote into `repo`, so any of them naming a hidden project
 * hides the card.
 */
export function isCardInVisibleProject(
  hidden: ReadonlySet<string>,
  card: ProjectAttributedCard,
): boolean {
  if (hidden.size === 0) return true;
  const named = [
    card.virtualMcpId,
    card.repo?.trim(),
    ...card.threads.map((thread) => thread.virtualMcpId),
  ];
  return !named.some((id) => id && hidden.has(id));
}

/**
 * Throws the not-found error a missing card gets when the caller's role hides
 * the card's project. Free for a caller with nothing hidden.
 */
export async function assertCardVisible(
  ctx: StudioContext,
  id: string,
  organizationId: string,
): Promise<void> {
  const hidden = await resolveHiddenProjectIds(ctx);
  if (hidden.size === 0) return;
  const card = await ctx.storage.taskBoard.getById(id, organizationId);
  if (card && !isCardInVisibleProject(hidden, card)) {
    throw new Error(`Task board item not found: ${id}`);
  }
}

/**
 * What a realtime listener whose role hides `hidden` projects receives for
 * `event`. A card update for a hidden project becomes that card's deletion,
 * so a card moved into one leaves the listener's board; a PR update for a
 * hidden card is dropped. Other events pass through.
 */
export async function boardEventForListener(
  hidden: ReadonlySet<string>,
  event: SSEEvent,
  getCard: (id: string) => Promise<ProjectAttributedCard | null>,
): Promise<SSEEvent | null> {
  if (hidden.size === 0) return event;
  if (event.type === TASK_BOARD_ITEM_UPDATED_EVENT) {
    if (isProjectAttributedCard(event.data)) {
      if (isCardInVisibleProject(hidden, event.data)) return event;
    }
    if (!event.subject) return null;
    return {
      ...event,
      type: TASK_BOARD_ITEM_DELETED_EVENT,
      data: { id: event.subject },
    };
  }
  if (event.type === TASK_BOARD_ITEM_PRS_UPDATED_EVENT) {
    const card = event.subject ? await getCard(event.subject) : null;
    return card && isCardInVisibleProject(hidden, card) ? event : null;
  }
  return event;
}
