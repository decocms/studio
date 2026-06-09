/**
 * Mounts org-fs volumes inside the sandbox so EVERY harness — including CLI
 * ones (Claude Code, Codex) that only read real files — sees them at
 * `<appRoot>/org/<volume>`, kext-free.
 *
 * Per volume: serve the WebDAV layer (over the mesh `/api/:org/fs` client) on a
 * loopback port, then hand that URL to a `Mounter` which has the OS mount it
 * (rclone nfsmount on macOS / rclone mount on Linux — see mounter.ts). The
 * `Mounter` is injected so this orchestration is unit-testable without a real
 * kernel mount.
 *
 * Boot-safety: a mount is purely additive. Every step is wrapped so a failure
 * logs and is skipped — it never breaks the daemon, the dev server, the fs
 * routes, or the harnesses. Mounting only happens when the mesh pushes
 * `TenantConfig.orgFs` (it won't for cluster pods, whose security posture
 * blocks mounts — desktop links are the target).
 */

import { mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { safePath } from "../paths";
// Portable serve-layer leaves from the mesh workspace (same cross-package
// import style entry.ts uses for harness factories).
import { OrgFsClient } from "../../../../apps/mesh/src/file-storage/mount/client";
import { createWebdavHandler } from "../../../../apps/mesh/src/file-storage/mount/webdav";
import type { OrgFsMountConfig } from "./config";

export type { OrgFsMountConfig, OrgFsVolumeMount } from "./config";

/** A handle to an established OS mount. */
export interface MountHandle {
  unmount(): Promise<void>;
}

/** Has the OS mount the loopback WebDAV URL at `mountPath` (impl in mounter.ts). */
export interface Mounter {
  mount(opts: { webdavUrl: string; mountPath: string }): Promise<MountHandle>;
}

interface ActiveMount {
  volume: string;
  mountPath: string;
  stopServer: () => void;
  handle: MountHandle;
}

/**
 * Resolve a mount path under `<appRoot>/org/`. Relative paths are placed there;
 * absolute paths are still clamped inside `appRoot` (defense — the config comes
 * from the cluster, but the clamp keeps a mount from escaping the workspace).
 */
export function resolveMountPath(appRoot: string, p: string): string | null {
  const orgRoot = join(appRoot, "org");
  if (isAbsolute(p)) {
    return p.startsWith(`${appRoot}/`) || p === appRoot ? p : null;
  }
  return safePath(appRoot, orgRoot, p);
}

export class MountManager {
  private active: ActiveMount[] = [];

  constructor(
    private readonly mounter: Mounter,
    private readonly log: (msg: string, err?: unknown) => void = (m, e) =>
      e ? console.warn(`[org-fs] ${m}`, e) : console.log(`[org-fs] ${m}`),
  ) {}

  /** Serve + mount every configured volume. Never throws. */
  async start(config: OrgFsMountConfig, appRoot: string): Promise<void> {
    for (const m of config.mounts) {
      try {
        const mountPath = resolveMountPath(appRoot, m.path);
        if (!mountPath) {
          this.log(`skip ${m.volume}: mount path "${m.path}" escapes appRoot`);
          continue;
        }
        mkdirSync(mountPath, { recursive: true });

        const client = new OrgFsClient({
          baseUrl: config.baseUrl,
          orgSlug: config.orgSlug,
          volume: m.volume,
          token: config.token,
        });
        // Loopback only; rclone is the sole client and it sits behind it.
        const server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: createWebdavHandler(client),
        });
        const webdavUrl = `http://127.0.0.1:${server.port}`;

        try {
          const handle = await this.mounter.mount({ webdavUrl, mountPath });
          this.active.push({
            volume: m.volume,
            mountPath,
            stopServer: () => server.stop(true),
            handle,
          });
          this.log(`mounted ${m.volume} at ${mountPath}`);
        } catch (err) {
          server.stop(true);
          this.log(`mount failed for ${m.volume} (skipped)`, err);
        }
      } catch (err) {
        this.log(`mount failed for ${m.volume} (skipped)`, err);
      }
    }
  }

  /** Unmount everything and stop the WebDAV servers. Never throws. */
  async stop(): Promise<void> {
    const mounts = this.active;
    this.active = [];
    await Promise.all(
      mounts.map(async (a) => {
        try {
          await a.handle.unmount();
        } catch (err) {
          this.log(`unmount failed for ${a.volume}`, err);
        }
        try {
          a.stopServer();
        } catch {
          // server already stopped
        }
      }),
    );
  }

  /** Mounted volumes (for status/health). */
  list(): { volume: string; mountPath: string }[] {
    return this.active.map((a) => ({
      volume: a.volume,
      mountPath: a.mountPath,
    }));
  }
}
