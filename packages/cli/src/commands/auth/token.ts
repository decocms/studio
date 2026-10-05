import { requireSession, type SessionOptions } from "../../lib/studio-request";
import { print } from "../../lib/output";

/**
 * Prints a valid access token, refreshing it first when expired, so scripts
 * never read the session file directly.
 */
export async function tokenCommand(options: SessionOptions): Promise<number> {
  const session = await requireSession(options);
  if (!session) return 1;
  print(session.accessToken);
  return 0;
}
