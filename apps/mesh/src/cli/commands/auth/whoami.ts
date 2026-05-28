import { getValidSession } from "../../lib/get-valid-session";
import { RefreshFailedError } from "../../lib/refresh-session";

export interface WhoamiOptions {
  dataDir: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

export async function whoamiCommand(options: WhoamiOptions): Promise<number> {
  let session;
  try {
    session = await getValidSession({
      dataDir: options.dataDir,
      fetch: options.fetch,
      now: options.now,
    });
  } catch (err) {
    if (err instanceof RefreshFailedError && err.kind === "transient") {
      console.error(
        `Could not refresh session: ${err.message}. Run \`decocms auth login\` to authenticate.`,
      );
      return 1;
    }
    throw err;
  }

  if (!session) {
    console.error("Not logged in. Run `decocms auth login` to authenticate.");
    return 1;
  }
  console.log(`Target: ${session.target}`);
  console.log(`User:   ${session.user.email ?? session.user.sub}`);
  return 0;
}
