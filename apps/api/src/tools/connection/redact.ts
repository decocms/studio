import { type ConnectionEntity, REDACTED_CONNECTION_TOKEN } from "./schema";

export function redactConnectionToken<T extends ConnectionEntity>(
  connection: T,
): T {
  if (connection.connection_token === null) return connection;
  return { ...connection, connection_token: REDACTED_CONNECTION_TOKEN };
}
