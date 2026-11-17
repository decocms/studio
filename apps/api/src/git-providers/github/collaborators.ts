/**
 * GitHub's vocabulary for repository collaborators, mapped to the neutral
 * `RepoCollaborator`. GitHub names the same five access levels three ways:
 * `role_name` on a collaborator, `permissions` on an invitation, and the
 * `permission` a write sends (`pull`/`push` for read/write).
 */

import { z } from "zod";
import type { CollaboratorPermission, RepoCollaborator } from "../types";

const GITHUB_ROLES: Record<string, CollaboratorPermission> = {
  read: "read",
  pull: "read",
  triage: "triage",
  write: "write",
  push: "write",
  maintain: "maintain",
  admin: "admin",
};

/** Pure: GitHub's name for an access level → the neutral one; null for a custom role. */
function collaboratorPermissionOf(
  role: string | null | undefined,
): CollaboratorPermission | null {
  return (role && GITHUB_ROLES[role]) || null;
}

/** Pure: the `permission` `PUT /repos/{o}/{r}/collaborators/{u}` expects. */
export function githubPermissionParam(
  permission: CollaboratorPermission,
): string {
  if (permission === "read") return "pull";
  if (permission === "write") return "push";
  return permission;
}

const GithubUserSchema = z.object({
  login: z.string().min(1),
  avatar_url: z.string().nullish(),
});

export const GithubCollaboratorsPageSchema = z.array(
  GithubUserSchema.extend({ role_name: z.string().nullish() }),
);

export const GithubInvitationsPageSchema = z.array(
  z.object({
    id: z.number().int().positive().safe(),
    // Null for an invitation sent to an email address.
    invitee: GithubUserSchema.nullable(),
    permissions: z.string().nullish(),
  }),
);

/** Pure: one page of `GET /repos/{o}/{r}/collaborators`. */
export function mapGithubCollaborators(
  page: z.infer<typeof GithubCollaboratorsPageSchema>,
): RepoCollaborator[] {
  return page.map((user) => ({
    login: user.login,
    avatarUrl: user.avatar_url ?? null,
    permission: collaboratorPermissionOf(user.role_name),
  }));
}

/** Pure: one page of `GET /repos/{o}/{r}/invitations`, without email invitations. */
export function mapGithubInvitations(
  page: z.infer<typeof GithubInvitationsPageSchema>,
): RepoCollaborator[] {
  return page.flatMap((invitation) =>
    invitation.invitee
      ? [
          {
            login: invitation.invitee.login,
            avatarUrl: invitation.invitee.avatar_url ?? null,
            permission: collaboratorPermissionOf(invitation.permissions),
          },
        ]
      : [],
  );
}
