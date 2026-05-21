/**
 * `deco link` — the desktop-side link daemon command.
 *
 * Boots a local Bun.serve on `--port` (default 5174), opens a Warp
 * tunnel to deco.host so the cluster can reach it, registers with the
 * cluster's `/api/links` to receive a `linkSecret`, then exposes the
 * control-plane HMAC handler (sandbox lifecycle + reverse-proxy).
 *
 * `--no-tunnel` skips Warp and registers `tunnelUrl=http://localhost:<port>`
 * — only honored when the cluster has `MESH_ALLOW_LOCALHOST_LINKS=1`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { startLinkDaemon } from "../../link-daemon";

export interface LinkCommandOptions {
  port?: number;
  noTunnel?: boolean;
  clusterBaseUrl?: string;
  dataDir?: string;
}

export async function runLinkCommand(
  opts: LinkCommandOptions = {},
): Promise<number> {
  const port = opts.port ?? 5174;
  const noTunnel = opts.noTunnel ?? false;
  // Matches the dataDir convention the rest of the CLI uses (auth login
  // writes session to ~/deco/...), so a fresh `deco link` after `deco
  // auth login` finds the session without DATA_DIR being set explicitly.
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
    const handle = await startLinkDaemon({
      port,
      noTunnel,
      clusterBaseUrl,
      dataDir,
    });
    return handle.stopped;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
