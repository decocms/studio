/**
 * `deco link` — start the desktop-side link daemon.
 *
 * Opens a WebSocket to `<MESH_CLUSTER_URL>/api/links/connect` and runs a
 * local ingress on `--port` for `<handle>.localhost` sandbox previews.
 *
 * Auth: calls `ensureSession` first. If the user has no session and is
 * running interactively, an OAuth login is launched inline. In CI / non-
 * interactive shells, surfaces a hard error.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "../lib/ensure-session";
import { startLinkDaemon } from "../../link-daemon";

export interface LinkCommandOptions {
  port?: number;
  clusterBaseUrl?: string;
  dataDir?: string;
}

export async function runLinkCommand(
  opts: LinkCommandOptions = {},
): Promise<number> {
  const port = opts.port ?? 5174;
  const dataDir =
    opts.dataDir ??
    process.env.DATA_DIR ??
    process.env.DECOCMS_HOME ??
    join(homedir(), "deco");
  const clusterBaseUrl =
    opts.clusterBaseUrl ??
    process.env.MESH_CLUSTER_URL ??
    "https://studio.decocms.com";

  try {
    const session = await ensureSession({ dataDir, intent: "Link" });
    const handle = await startLinkDaemon({
      port,
      clusterBaseUrl,
      dataDir,
      session,
    });
    return handle.stopped;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
