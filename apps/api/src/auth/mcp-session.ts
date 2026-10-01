import { z } from "zod";
import type { BetterAuthInstance } from "./index";

const McpAccessTokenRowSchema = z.object({
  userId: z.string().min(1),
  accessTokenExpiresAt: z.coerce.date(),
});

/**
 * The user behind an MCP OAuth access token row, or null when the row is
 * malformed or expired. Pure — exported for unit tests.
 */
export function activeMcpTokenUserId(row: unknown, now: Date): string | null {
  const parsed = McpAccessTokenRowSchema.safeParse(row);
  if (!parsed.success) return null;
  if (!(parsed.data.accessTokenExpiresAt.getTime() > now.getTime())) {
    return null;
  }
  return parsed.data.userId;
}

/**
 * Resolve the MCP OAuth bearer in `headers` to its user. Use this instead of
 * calling `auth.api.getMcpSession` directly: better-auth 1.4 looks the token
 * up by value and returns the row without checking `accessTokenExpiresAt`
 * (1.6 added the check).
 */
export async function getActiveMcpSessionUserId(
  auth: BetterAuthInstance,
  headers: Headers,
): Promise<string | null> {
  const row: unknown = await auth.api.getMcpSession({ headers });
  return activeMcpTokenUserId(row, new Date());
}
