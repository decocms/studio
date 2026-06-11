import {
  normalizeCoAuthorIdentity,
  type CoAuthorIdentity,
} from "@decocms/sandbox/shared";
import type { StudioContext } from "../core/studio-context";

export function coAuthorFromStudioContext(
  ctx: StudioContext,
): CoAuthorIdentity | null {
  return normalizeCoAuthorIdentity({
    userName: ctx.auth.user?.name,
    userEmail: ctx.auth.user?.email,
  });
}

export function coAuthorFromSessionUser(
  user: { name?: string | null; email?: string | null } | null | undefined,
): CoAuthorIdentity | null {
  return normalizeCoAuthorIdentity({
    userName: user?.name,
    userEmail: user?.email,
  });
}
