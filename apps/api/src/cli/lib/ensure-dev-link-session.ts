import { join } from "node:path";
import { sleep } from "@decocms/shared/std";
import { ensureSession } from "./ensure-session";
import { getValidSession } from "./get-valid-session";

const LOCAL_MODE_SESSION_WAIT_MS = 30_000;

export interface EnsureDevLinkSessionOptions {
  localMode: boolean;
  /** Where the auto-spawned link daemon reads/writes session + sandboxes. */
  linkDataDir: string;
  /** Developer DECOCMS_HOME — source of OAuth sessions in non-local mode. */
  studioDataDir: string;
  serverUrl: string;
  /** When true, may open the browser for a one-time `auth login` flow. */
  isInteractive: boolean;
}

/**
 * Prepares auth for the dev auto-spawned link daemon before `ensureLink` runs.
 *
 * - **local mode**: waits for the cluster's `bootstrapDevLinkSession` API-key
 *   file at `<linkDataDir>/session.json`.
 * - **non-local mode**: requires a valid OAuth session for `serverUrl` in
 *   `studioDataDir` (same files as `decocms auth login --target <url>`).
 *   Opens the browser once when interactive and no session exists yet.
 */
export async function ensureDevLinkSession(
  opts: EnsureDevLinkSessionOptions,
): Promise<void> {
  if (opts.localMode) {
    const sessionPath = join(opts.linkDataDir, "session.json");
    const deadline = Date.now() + LOCAL_MODE_SESSION_WAIT_MS;
    while (Date.now() < deadline) {
      if (await Bun.file(sessionPath).exists()) return;
      await sleep(250);
    }
    throw new Error(
      `[dev-link] session.json not minted at ${sessionPath} after ${LOCAL_MODE_SESSION_WAIT_MS / 1000}s — check cluster logs for [dev-link] errors`,
    );
  }

  let session = await getValidSession({
    dataDir: opts.studioDataDir,
    target: opts.serverUrl,
  });
  if (!session && opts.isInteractive) {
    session = await ensureSession({
      dataDir: opts.studioDataDir,
      intent: "Link (dev sandbox)",
      target: opts.serverUrl,
      isInteractive: true,
    });
  }
  if (!session) {
    throw new Error(
      `[dev-link] No session for ${opts.serverUrl}. Run \`decocms auth login --target ${opts.serverUrl}\` once, then re-run \`bun run dev\`.`,
    );
  }
}
