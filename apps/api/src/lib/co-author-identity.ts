import {
  normalizeCoAuthorIdentity,
  type CoAuthorIdentity,
  type CommitOperator,
} from "@decocms/sandbox/shared";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { orgFlagsCached } from "../core/org-flags-cache";
import type { StudioContext } from "../core/studio-context";

export function coAuthorFromStudioContext(
  ctx: StudioContext,
): CoAuthorIdentity | undefined {
  return (
    normalizeCoAuthorIdentity({
      userName: ctx.auth.user?.name,
      userEmail: ctx.auth.user?.email,
    }) ?? undefined
  );
}

/**
 * The acting user as a commit identity, carrying their organization's
 * `commits_authored_by_editor` answer. Every commit Studio writes on someone's
 * behalf goes through here, so no path can attribute one without consulting
 * the flag. The settings read is cached per org, not made per request.
 */
export async function commitOperatorFromStudioContext(
  ctx: StudioContext,
): Promise<CommitOperator | undefined> {
  const identity = coAuthorFromStudioContext(ctx);
  if (!identity) return undefined;
  const organizationId = ctx.organization?.id;
  const flags = organizationId
    ? await orgFlagsCached(ctx, organizationId)
    : null;
  return {
    ...identity,
    operatorId: ctx.auth.user?.id,
    authorsCommit: orgFlagEnabled(flags, "commits_authored_by_editor"),
  };
}

/**
 * The operator for a commit that carried no attribution at all before the
 * flag — the branch sync's squash and the discard. Off the flag they stay
 * exactly as they were, rather than gaining a co-author trailer.
 */
export function authoringOperator(
  operator: CommitOperator | undefined,
): CommitOperator | null {
  return operator?.authorsCommit ? operator : null;
}
