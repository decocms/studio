/**
 * User Storage
 *
 * Provides access to Better Auth user data with organization-scoped access control.
 * Users can only fetch data for users in their shared organizations.
 */

import type { Kysely } from "kysely";
import type { Database, UserWithImage } from "./types";
import { escapeLikePattern } from "./virtual";

/** An organization the user belongs to, as the org search returns it. */
export interface MembershipOrganization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  metadata: string | null;
}

/**
 * User storage interface
 */
export interface UserStoragePort {
  findById(
    userId: string,
    requestingUserId: string,
  ): Promise<UserWithImage | null>;
  searchOrganizations(options: {
    userId: string;
    term: string;
    limit: number;
    offset?: number;
    organizationId?: string | null;
  }): Promise<MembershipOrganization[]>;
}

/**
 * User storage implementation using Kysely
 */
export class UserStorage implements UserStoragePort {
  constructor(private db: Kysely<Database>) {}

  /**
   * Find a user by ID, ensuring the requesting user shares at least one organization
   *
   * @param userId - The user ID to fetch
   * @param requestingUserId - The user making the request (for authorization)
   * @returns User data or null if not found/unauthorized
   */
  async findById(
    userId: string,
    requestingUserId: string,
  ): Promise<UserWithImage | null> {
    // Query the user table, but only if the requesting user shares an organization
    // with the target user (via the member table)
    const result = await this.db
      .selectFrom("user")
      .select([
        "user.id",
        "user.name",
        "user.email",
        "user.image",
        "user.createdAt",
        "user.updatedAt",
      ])
      .where("user.id", "=", userId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("member as m1")
            .innerJoin("member as m2", "m1.organizationId", "m2.organizationId")
            .select("m1.id")
            .where("m1.userId", "=", userId)
            .where("m2.userId", "=", requestingUserId),
        ),
      )
      .executeTakeFirst();

    if (!result) {
      return null;
    }

    return {
      id: result.id,
      name: result.name,
      email: result.email,
      role: "", // Not exposed in this context
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      image: result.image ?? undefined,
    };
  }

  /**
   * Organizations the user belongs to whose name or slug contains `term`.
   * Better Auth's own list stops at its adapter's default page of 100, so a
   * search over it cannot reach the rest of a large membership.
   */
  async searchOrganizations(options: {
    userId: string;
    term: string;
    limit: number;
    /** Page offset, so a caller that drops rows (archived, SSO-blocked) can
     *  refill its page. */
    offset?: number;
    /** Fence a credential-authenticated caller to one organization. */
    organizationId?: string | null;
  }): Promise<MembershipOrganization[]> {
    const { userId, term, limit, offset = 0, organizationId } = options;
    const pattern = `%${escapeLikePattern(term)}%`;

    let query = this.db
      .selectFrom("organization")
      // EXISTS, not a join: a user can hold two member rows in one org.
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("member")
            .select("member.id")
            .whereRef("member.organizationId", "=", "organization.id")
            .where("member.userId", "=", userId),
        ),
      )
      .where((eb) =>
        eb.or([
          eb("organization.name", "ilike", pattern),
          eb("organization.slug", "ilike", pattern),
        ]),
      );

    if (organizationId) {
      query = query.where("organization.id", "=", organizationId);
    }

    return await query
      .select([
        "organization.id as id",
        "organization.name as name",
        "organization.slug as slug",
        "organization.logo as logo",
        "organization.metadata as metadata",
      ])
      .orderBy("organization.name", "asc")
      .orderBy("organization.id", "asc")
      .limit(limit)
      .offset(offset)
      .execute();
  }
}
