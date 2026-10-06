import { clearSession, readSession } from "../../lib/session";
import { print } from "../../lib/output";

export interface LogoutOptions {
  dataDir: string;
}

export async function logoutCommand(options: LogoutOptions): Promise<number> {
  const session = await readSession(options.dataDir);
  if (!session) {
    print("Already logged out.");
    return 0;
  }
  await clearSession(options.dataDir);
  print("Logged out.");
  return 0;
}
