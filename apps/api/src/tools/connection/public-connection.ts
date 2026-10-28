import type { ConnectionEntity } from "./schema";

/** The token can outrank the caller (the org's `_self` key is full-access), so responses only say whether one is set. */
export function toPublicConnection(
  connection: ConnectionEntity,
): Omit<ConnectionEntity, "connection_token"> {
  const { connection_token: token, ...rest } = connection;
  return { ...rest, has_connection_token: !!token };
}
