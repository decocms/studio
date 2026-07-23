/**
 * Mounts org-fs volumes inside the sandbox so EVERY harness — including CLI
 * ones (Claude Code, Codex) that only read real files — sees them at
 * `<appRoot>/org/<volume>`, kext-free.
 *
 * Per volume: serve the WebDAV layer (over the studio `/api/:org/fs` client) on a
 * loopback port, then hand that URL to a `Mounter` which has the OS mount it
 * (rclone nfsmount on macOS / rclone mount on Linux — see mounter.ts). The
 * `Mounter` is injected so this orchestration is unit-testable without a real
 * kernel mount.
 *
 * Boot-safety: a mount is purely additive. Every step is wrapped so a failure
 * logs and is skipped — it never breaks the daemon, the dev server, the fs
 * routes, or the harnesses. Mounting only happens when the studio pushes
 * `TenantConfig.orgFs` (it won't for cluster pods, whose security posture
 * blocks mounts — desktop links are the target).
 */

import { mkdirSync } from "node:fs";
import * as net from "node:net";
import { join, isAbsolute } from "node:path";
import { safePath } from "../paths";
import { OrgFsClient } from "./client";
import { createWebdavHandler } from "./webdav";
import type { OrgFsMountConfig, OrgFsVolumeMount } from "./config";
import { makeRcRefresh, runInvalidator } from "./invalidator";

export type { OrgFsMountConfig, OrgFsVolumeMount } from "./config";

/** A handle to an established OS mount. */
export interface MountHandle {
  unmount(): Promise<void>;
  /**
   * Resolves when the underlying mount process exits. Lets MountManager notice
   * an unexpected rclone death (crash/OOM with the daemon still alive) and
   * self-heal before the mount goes stale. Optional: fakes/tests may omit it.
   */
  exited?: Promise<number>;
}

/**
 * Has the OS mount the loopback WebDAV URL at `mountPath` (impl in mounter.ts).
 * `rcAddr`, when set, is where rclone should expose its control API so the
 * invalidator can drive `vfs/refresh`.
 */
export interface Mounter {
  mount(opts: {
    webdavUrl: string;
    mountPath: string;
    rcAddr?: string;
    /** Read-only mount (public skill sets). */
    readonly?: boolean;
  }): Promise<MountHandle>;
}

/** Background cache-invalidation for one mounted volume. */
export interface VolumeInvalidator {
  stop(): void;
}

/**
 * Starts near-realtime invalidation for a freshly-mounted volume. Injected so
 * MountManager's orchestration is unit-testable without a real rclone rc or
 * studio (mirrors the `Mounter` seam).
 */
export type InvalidatorFactory = (opts: {
  client: OrgFsClient;
  rcUrl: string;
  volume: string;
  log: (msg: string, err?: unknown) => void;
}) => VolumeInvalidator;

/** Real factory: poll the change feed → rclone `vfs/refresh` (see invalidator.ts). */
const defaultInvalidatorFactory: InvalidatorFactory = ({
  client,
  rcUrl,
  log,
}) => {
  const ac = new AbortController();
  void runInvalidator({
    // wait: true → server holds the request open until a write nudge or its
    // hold timeout, so this is push-driven with the poll floor as a safety net.
    changes: (since) => client.changes(since, { wait: true }),
    refresh: makeRcRefresh(rcUrl),
    signal: ac.signal,
    log,
  });
  return { stop: () => ac.abort() };
};

interface ActiveMount {
  volume: string;
  mountPath: string;
  stopServer: () => void;
  handle: MountHandle;
  invalidator: VolumeInvalidator;
  /**
   * Set before any intentional teardown (`stop()` or the death watcher's own
   * cleanup) so the `handle.exited` watcher can tell a deliberate unmount apart
   * from a crash and not fight it / re-mount over it.
   */
  closing: boolean;
}

/** Bind :0 to grab a free loopback port for rclone's rc, then release it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) =>
        err || !port ? reject(err ?? new Error("no free port")) : resolve(port),
      );
    });
  });
}

/**
 * Resolve a mount path under `<appRoot>/org/`. Relative paths are placed there;
 * absolute paths are still clamped inside `appRoot` (defense — the config comes
 * from the cluster, but the clamp keeps a mount from escaping the workspace).
 */
export function resolveMountPath(appRoot: string, p: string): string | null {
  const orgRoot = join(appRoot, "org");
  // Route absolute paths through the same resolve-then-clamp check relative
  // paths get below — a raw `startsWith(appRoot)` never normalizes `..`
  // segments, so e.g. "<appRoot>/../../etc" passes the prefix check while
  // actually resolving outside appRoot.
  if (isAbsolute(p)) {
    return safePath(appRoot, appRoot, p);
  }
  return safePath(appRoot, orgRoot, p);
}

export class MountManager {
  private active: ActiveMount[] = [];
  private config: OrgFsMountConfig | null = null;
  private appRoot = "";
  private stopped = false;

  constructor(
    private readonly mounter: Mounter,
    private readonly log: (msg: string, err?: unknown) => void = (m, e) =>
      e ? console.warn(`[org-fs] ${m}`, e) : console.log(`[org-fs] ${m}`),
    private readonly startInvalidator: InvalidatorFactory = defaultInvalidatorFactory,
    /**
     * Injectable for tests; defaults to the real OS. Gated here (not just in
     * mounter.ts) so a Windows daemon never calls `mountOne` at all — `active`
     * stays empty and `list()` returns `[]`, which is what entry.ts's
     * per-run link gate (see its docblock) relies on to keep it off rather
     * than symlinking into an unbacked directory.
     */
    private readonly platform: string = process.platform,
  ) {}

  /** Serve + mount every configured volume. Never throws. */
  async start(config: OrgFsMountConfig, appRoot: string): Promise<void> {
    this.config = config;
    this.appRoot = appRoot;
    this.stopped = false;
    if (this.platform === "win32") {
      this.log(
        `org file mounts are not supported on Windows — skipping ${config.mounts.length} volume(s) (files remain available via the Studio UI)`,
      );
      return;
    }
    for (const m of config.mounts) {
      await this.mountOne(m);
    }
  }

  /**
   * Serve + mount a single volume and register it in `active`. Never throws.
   * `canRemount` gates the death-watcher's one-shot self-heal: the initial
   * mount allows it, a watcher-triggered remount does not (bounds it to a
   * single retry — see "Out of scope" follow-up for backoff).
   */
  private async mountOne(
    m: OrgFsVolumeMount,
    canRemount = true,
  ): Promise<void> {
    const config = this.config;
    if (!config || this.stopped) return;
    try {
      const mountPath = resolveMountPath(this.appRoot, m.path);
      if (!mountPath) {
        this.log(`skip ${m.volume}: mount path "${m.path}" escapes appRoot`);
        return;
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
        const rcAddr = `127.0.0.1:${await freePort()}`;
        const handle = await this.mounter.mount({
          webdavUrl,
          mountPath,
          rcAddr,
          readonly: m.readonly,
        });
        // Near-realtime freshness: feed-driven vfs/refresh against rclone's rc.
        const invalidator = this.startInvalidator({
          client,
          rcUrl: `http://${rcAddr}`,
          volume: m.volume,
          log: this.log,
        });
        const entry: ActiveMount = {
          volume: m.volume,
          mountPath,
          stopServer: () => server.stop(true),
          handle,
          invalidator,
          closing: false,
        };
        this.active.push(entry);
        // Self-heal: an unexpected rclone death (crash/OOM, daemon still alive)
        // would leave a stale mount that hangs/nags. Watch the child's exit and
        // reclaim + remount once. A deliberate unmount sets `closing` first, so
        // this only fires on a real crash.
        void handle.exited?.then(() => {
          void this.onRcloneExit(entry, m, canRemount);
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

  /**
   * React to an unexpected rclone exit: drop the entry, reclaim the now-stale
   * kernel mount (rclone is already gone, so `unmount()` just force-detaches),
   * then remount once if allowed. Never throws.
   */
  private async onRcloneExit(
    entry: ActiveMount,
    m: OrgFsVolumeMount,
    canRemount: boolean,
  ): Promise<void> {
    if (entry.closing) return; // deliberate teardown — not a crash
    const idx = this.active.indexOf(entry);
    if (idx === -1) return; // already removed
    entry.closing = true;
    this.active.splice(idx, 1);
    this.log(`rclone for ${entry.volume} exited unexpectedly; reclaiming`);
    try {
      entry.invalidator.stop();
    } catch {
      // already stopped
    }
    try {
      await entry.handle.unmount();
    } catch (err) {
      this.log(`reclaim unmount failed for ${entry.volume}`, err);
    }
    try {
      entry.stopServer();
    } catch {
      // server already stopped
    }
    if (this.stopped || !canRemount) {
      if (!canRemount)
        this.log(`not remounting ${entry.volume} (retried once)`);
      return;
    }
    this.log(`remounting ${entry.volume}`);
    await this.mountOne(m, false); // the remount itself does not re-remount
  }

  /** Unmount everything and stop the WebDAV servers. Never throws. */
  async stop(): Promise<void> {
    this.stopped = true;
    const mounts = this.active;
    this.active = [];
    // Flag intent before any unmount so each handle.exited watcher sees a
    // deliberate teardown and doesn't try to reclaim/remount.
    for (const a of mounts) a.closing = true;
    await Promise.all(
      mounts.map(async (a) => {
        try {
          a.invalidator.stop();
        } catch {
          // already stopped
        }
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
