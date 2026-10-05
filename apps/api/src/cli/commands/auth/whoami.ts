import { requireSession, type SessionOptions } from "../../lib/studio-request";

export async function whoamiCommand(options: SessionOptions): Promise<number> {
  const session = await requireSession(options);
  if (!session) return 1;
  console.log(`Target: ${session.target}`);
  console.log(`User:   ${session.user.email ?? session.user.sub}`);
  return 0;
}
