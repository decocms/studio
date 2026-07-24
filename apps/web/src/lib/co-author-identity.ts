import {
  normalizeCoAuthorIdentity,
  type CoAuthorIdentity,
} from "@decocms/sandbox/shared";

export function coAuthorFromSessionUser(
  user: { name?: string | null; email?: string | null } | null | undefined,
): CoAuthorIdentity | undefined {
  return (
    normalizeCoAuthorIdentity({
      userName: user?.name,
      userEmail: user?.email,
    }) ?? undefined
  );
}
