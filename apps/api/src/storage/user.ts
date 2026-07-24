/**
 * User Storage
 *
 * Provides access to Better Auth user data with organization-scoped access control.
 * Users can only fetch data for users in their shared organizations.
 */

import type { Kysely } from "kysely";
import type { Database, UserWithImage } from "./types";

/**
 * User storage interface
 */
export interface UserStoragePort {
  findById(
    userId: string,
    requestingUserId: string,
  ): Promise<UserWithImage | null>;
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
}
