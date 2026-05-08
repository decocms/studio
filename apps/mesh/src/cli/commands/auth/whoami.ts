import { readSession } from "../../lib/session";

export interface WhoamiOptions {
  dataDir: string;
}

export async function whoamiCommand(options: WhoamiOptions): Promise<number> {
  const session = await readSession(options.dataDir);
  if (!session) {
    console.error("Not logged in. Run `decocms auth login` to authenticate.");
    return 1;
  }
  console.log(`Target: ${session.target}`);
  console.log(`User:   ${session.user.email ?? session.user.sub}`);
  return 0;
}
