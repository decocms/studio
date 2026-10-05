/**
 * Entry point for the org-fs sidecar image (see
 * deploy/helm/sandbox-env/orgfs-sidecar/). Env contract (set by the chart):
 *   APP_ROOT                   shared workdir root (default /app)
 *   ORGFS_SIDECAR_CONFIG_PATH  relayed config file (default /run/orgfs/config.json)
 *   ORGFS_SIDECAR_STATUS_PATH  mounted-status file (default /run/orgfs/status.json)
 *   ORGFS_RCLONE_PATH          rclone binary (default: PATH lookup; baked in image)
 *   ORGFS_CHANGE_FEED          `off` skips the change-feed invalidator, leaving
 *                              freshness to rclone's dir-cache TTL
 */

import { MountManager } from "./mount-manager";
import { createRcloneMounter } from "./mounter";
import { runSidecar } from "./sidecar";

const rclonePath =
  process.env.ORGFS_RCLONE_PATH ?? Bun.which("rclone") ?? "rclone";

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
process.on("SIGINT", () => ac.abort());

console.log("[org-fs sidecar] waiting for relayed config…");
await runSidecar({
  configPath: process.env.ORGFS_SIDECAR_CONFIG_PATH ?? "/run/orgfs/config.json",
  statusPath: process.env.ORGFS_SIDECAR_STATUS_PATH ?? "/run/orgfs/status.json",
  appRoot: process.env.APP_ROOT ?? "/app",
  manager: new MountManager(
    createRcloneMounter(rclonePath, { allowOther: true }),
    undefined,
    process.env.ORGFS_CHANGE_FEED === "off" ? () => ({ stop() {} }) : undefined,
  ),
  signal: ac.signal,
  log: (m, e) =>
    e
      ? console.warn(`[org-fs sidecar] ${m}`, e)
      : console.log(`[org-fs sidecar] ${m}`),
});
console.log("[org-fs sidecar] stopped");
process.exit(0);
