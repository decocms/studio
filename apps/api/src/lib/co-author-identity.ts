import {
  normalizeCoAuthorIdentity,
  type CoAuthorIdentity,
} from "@decocms/sandbox/shared";
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
