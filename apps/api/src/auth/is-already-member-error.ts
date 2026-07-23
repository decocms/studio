/**
 * Better Auth's `addMember` throws when the user is already in the org. There's
 * no stable error code exposed on the thrown value, so this matches the message
 * ("User is already a member of this organization"). Centralized so a wording
 * change in a better-auth upgrade is fixed in one place instead of the four
 * call sites that add members idempotently.
 */
export function isAlreadyMemberError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  return message.includes("already a member");
}
