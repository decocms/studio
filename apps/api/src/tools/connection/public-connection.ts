import type { ConnectionEntity } from "./schema";

/**
 * A connection as tools return it. The token can outrank the caller (the org's
 * `_self` key is full-access), so responses only say whether one is set.
 */
export type PublicConnectionEntity = Omit<
  ConnectionEntity,
  "connection_token"
> & { has_connection_token: boolean };

/** For entities that already hold the token: write results and synthetic connections. */
export function toPublicConnection(
  connection: ConnectionEntity,
): PublicConnectionEntity {
  const { connection_token: token, ...rest } = connection;
  return { ...rest, has_connection_token: !!token };
}
