import { requireSession } from "../../lib/studio-request";

export interface WhoamiOptions {
  dataDir: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

export async function whoamiCommand(options: WhoamiOptions): Promise<number> {
  const session = await requireSession(options);
  if (!session) return 1;
  console.log(`Target: ${session.target}`);
  console.log(`User:   ${session.user.email ?? session.user.sub}`);
  return 0;
}
