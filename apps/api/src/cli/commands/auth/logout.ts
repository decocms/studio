import { clearSession, readSession } from "../../lib/session";

export interface LogoutOptions {
  dataDir: string;
  /** Studio to log out of (host-keyed). Omit to clear every session on disk. */
  target?: string;
}

export async function logoutCommand(options: LogoutOptions): Promise<number> {
  const session = await readSession(options.dataDir, options.target);
  if (!session) {
    console.log("Already logged out.");
    return 0;
  }
  await clearSession(options.dataDir, options.target);
  console.log("Logged out.");
  return 0;
}
