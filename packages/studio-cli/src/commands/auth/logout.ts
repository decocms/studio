import { clearSession, readSession } from "../../lib/session";

export interface LogoutOptions {
  dataDir: string;
}

export async function logoutCommand(options: LogoutOptions): Promise<number> {
  const session = await readSession(options.dataDir);
  if (!session) {
    console.log("Already logged out.");
    return 0;
  }
  await clearSession(options.dataDir);
  console.log("Logged out.");
  return 0;
}
