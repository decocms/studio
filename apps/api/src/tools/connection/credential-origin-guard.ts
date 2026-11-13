/**
 * Who may point a connection that holds credentials at another server.
 *
 * Studio sends a connection's stored token, OAuth access token and custom
 * headers to whatever `connection_url` it has. If any member could change
 * that URL's origin, they could point the connection at a host they control
 * and receive credentials someone else set up. Owners and admins may still
 * move it; nothing stored is deleted, so moving it back keeps working.
 */

import { hasAdminRole } from "@decocms/shared/auth/roles";
import { ForbiddenError } from "../../core/access-control";
import type { StudioContext } from "../../core/studio-context";
import { isStdioParameters, type ConnectionEntity } from "./schema";

/** Where credentials are sent: the URL's origin, or the URL itself when it has none. */
function credentialAudience(url: string | null): string | null {
  if (!url) return null;
  try {
    const { origin } = new URL(url);
    return origin === "null" ? url : origin;
  } catch {
    return url;
  }
}

export function changesCredentialOrigin(
  existingUrl: string | null,
  finalUrl: string | null,
): boolean {
  return credentialAudience(existingUrl) !== credentialAudience(finalUrl);
}

function hasCustomHeaders(connection: ConnectionEntity): boolean {
  const params = connection.connection_headers;
  if (!params || isStdioParameters(params)) return false;
  return Object.keys(params.headers ?? {}).length > 0;
}

async function hasStoredCredentials(
  ctx: StudioContext,
  connection: ConnectionEntity,
): Promise<boolean> {
  if (connection.connection_token || hasCustomHeaders(connection)) return true;
  const oauthToken = await ctx.db
    .selectFrom("downstream_tokens")
    .select("id")
    .where("connectionId", "=", connection.id)
    .executeTakeFirst();
  return !!oauthToken;
}

export async function assertMayMoveCredentials(
  ctx: StudioContext,
  existing: ConnectionEntity,
  finalUrl: string | null,
): Promise<void> {
  if (!changesCredentialOrigin(existing.connection_url, finalUrl)) return;
  if (hasAdminRole(ctx.access.getRole())) return;
  if (!(await hasStoredCredentials(ctx, existing))) return;
  throw new ForbiddenError(
    "Only organization owners and admins can point a connection with saved credentials at another server",
  );
}
