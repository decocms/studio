/**
 * Organization reads for bearer principals Better Auth holds no session for
 * (MCP OAuth access tokens, Studio JWTs). Its organization endpoints require
 * a session, and the API key plugin rejects the bearer, so these mirror
 * `listOrganizations` and `getFullOrganization` through Better Auth's own
 * adapter to keep the same result shapes.
 */
import { ForbiddenError } from "./access-control";
import type {
  BetterAuthInstance,
  GetFullOrganizationResult,
  ListOrganizationsResult,
} from "./studio-context";

type FullOrganization = NonNullable<GetFullOrganizationResult>;
type MemberWithUser = FullOrganization["members"][number];

export async function listOrganizationsForUser(
  auth: BetterAuthInstance,
  userId: string,
): Promise<ListOrganizationsResult> {
  const { adapter } = await auth.$context;
  const rows = await adapter.findMany<{
    organization: ListOrganizationsResult[number];
  }>({
    model: "member",
    where: [{ field: "userId", value: userId }],
    join: { organization: true },
  });
  return rows.map((row) => row.organization);
}

/**
 * The organization with its members and invitations, for a member of it.
 * Membership is checked before the lookup so a non-member learns nothing
 * about whether the organization exists.
 */
export async function getFullOrganizationForUser(
  auth: BetterAuthInstance,
  userId: string,
  organizationId: string,
): Promise<GetFullOrganizationResult> {
  const { adapter } = await auth.$context;
  const membership = await adapter.findOne({
    model: "member",
    where: [
      { field: "userId", value: userId },
      { field: "organizationId", value: organizationId },
    ],
  });
  if (!membership) {
    throw new ForbiddenError("You are not a member of this organization");
  }

  const result = await adapter.findOne<
    Omit<FullOrganization, "members" | "invitations"> & {
      member: Omit<MemberWithUser, "user">[];
      invitation: FullOrganization["invitations"];
    }
  >({
    model: "organization",
    where: [{ field: "id", value: organizationId }],
    join: { invitation: true, member: true },
  });
  if (!result) return null;

  const { invitation: invitations, member: members, ...org } = result;
  const users =
    members.length > 0
      ? await adapter.findMany<MemberWithUser["user"]>({
          model: "user",
          where: [
            {
              field: "id",
              value: members.map((m) => m.userId),
              operator: "in",
            },
          ],
          limit: members.length,
        })
      : [];
  const userById = new Map(users.map((user) => [user.id, user]));
  const membersWithUsers = members.flatMap((member) => {
    const user = userById.get(member.userId);
    return user
      ? [
          {
            ...member,
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              image: user.image,
            },
          },
        ]
      : [];
  });
  return { ...org, invitations, members: membersWithUsers };
}
