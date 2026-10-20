import {
  normalizeCoAuthorIdentity,
  type CoAuthorIdentity,
  type CommitOperator,
} from "@decocms/sandbox/shared";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
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
 * the flag. One settings read per request, not per commit.
 */
export async function commitOperatorFromStudioContext(
  ctx: StudioContext,
): Promise<CommitOperator | undefined> {
  const identity = coAuthorFromStudioContext(ctx);
  if (!identity) return undefined;
  const organizationId = ctx.organization?.id;
  const settings = organizationId
    ? await ctx.storage.organizationSettings
        .get(organizationId)
        .catch(() => null)
    : null;
  return {
    ...identity,
    authorsCommit: orgFlagEnabled(
      settings?.flags,
      "commits_authored_by_editor",
    ),
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
