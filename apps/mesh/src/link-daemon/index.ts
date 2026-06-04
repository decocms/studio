/**
 * Desktop-side link daemon.
 *
 * - Receives an authenticated session from its caller (the CLI's `link`
 *   command obtains one via `ensureSession`).
 * - Opens a WebSocket to `<MESH_CLUSTER_URL>/api/links/connect` with the
 *   session bearer; sends the `hello` frame.
 * - Spawns the local ingress on `--port` so browsers can reach
 *   `<handle>.localhost:<port>` for sandbox previews.
 * - Dispatches incoming control-plane requests (sandbox lifecycle + the
 *   harness streaming endpoint) into the in-process handler.
 */
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  postConfig as daemonPostConfig,
  waitForDaemonReady,
} from "@decocms/sandbox/daemon-client";
import { createDefaultDaemonSpawn } from "@decocms/sandbox/daemon-spawn";
import { detectCapabilities } from "./capabilities";
import { createControlHandler } from "./control-handler";
import { connectToCluster } from "./cluster-connection";
import { startLocalIngress } from "./local-ingress";
import { loadOrCreateMachineId } from "./machine-id";
import { getValidSession } from "../cli/lib/get-valid-session";
import type { Session } from "../cli/lib/session";
import {
  createDesktopSandboxProvider,
  type SandboxEvent,
  type SpawnResult,
} from "./user-desktop-provider";

/**
 * Optional observability hooks for the `deco link` TUI. All no-ops when the
 * daemon runs with `--no-tui` (the monitor is simply omitted).
 */
export interface LinkDaemonMonitor {
  onEvent?: (event: SandboxEvent) => void;
  onIngress?: (port: number) => void;
  onCluster?: (status: "connecting" | "linked" | "closed") => void;
  onMachine?: (label: string) => void;
}

export interface StartLinkDaemonOptions {
  port: number;
  clusterBaseUrl: string;
  dataDir: string;
  /**
   * Authenticated session used to bind the WebSocket to the cluster.
   * Callers (e.g. the CLI's `link` command) obtain this via
   * `ensureSession()` before invoking the daemon.
   */
  session: Session;
  /** Optional TUI hooks. Omitted in --no-tui mode. */
  monitor?: LinkDaemonMonitor;
  /**
   * When set, spawned sandbox daemons write stdout/stderr to this file
   * descriptor (the `deco link` log file) instead of inheriting the
   * terminal. Omitted in `--no-tui` / managed mode so their output streams
   * to the parent process.
   */
  logFd?: number;
}

export interface LinkDaemonHandle {
  stopped: Promise<number>;
  stop: () => Promise<void>;
}

export async function startLinkDaemon(
  opts: StartLinkDaemonOptions,
): Promise<LinkDaemonHandle> {
  const session = opts.session;

  const machineId = await loadOrCreateMachineId(opts.dataDir);
  const cliVersion = process.env.npm_package_version ?? "0.0.0";
  const hostname = osHostname() || undefined;
  opts.monitor?.onMachine?.(hostname ?? "this machine");

  const innerSpawn = createDefaultDaemonSpawn(opts.dataDir, {
    outFd: opts.logFd,
  });
  // Forward declaration so `resolvePreviewUrl` can read the ingress port
  // once the ingress finishes binding (the ingress's `lookupSandboxPort`
  // calls into the provider, so the two have a circular initialization).
  let ingressPort = 0;
  const provider = createDesktopSandboxProvider({
    dataDir: opts.dataDir,
    resolvePreviewUrl: (handle, port) =>
      ingressPort > 0
        ? `http://${handle}.localhost:${ingressPort}`
        : `http://127.0.0.1:${port}`,
    spawnDaemon: (args): Promise<SpawnResult> => {
      const env: Record<string, string> = {
        DAEMON_BOOT_ID: randomUUID(),
        APP_ROOT: args.workdir,
        PROXY_PORT: String(args.port),
        DAEMON_TOKEN: args.daemonToken,
        // Message-offload SSRF allowlist, pushed by the cluster via the ensure
        // body (trusted config — never a request frame). The daemon reads
        // these at boot (`packages/sandbox/daemon/entry.ts`) and rejects any
        // offload fetch whose host isn't listed. Empty = fail closed.
        OFFLOAD_ALLOWED_HOSTS: args.offloadAllowedHosts.join(","),
        ...(args.offloadAllowSameHostDev
          ? { OFFLOAD_ALLOW_SAME_HOST_DEV: "1" }
          : {}),
      };
      return innerSpawn({
        workdir: args.workdir,
        env,
        daemonPort: args.port,
      }).then((proc) => ({
        port: args.port,
        kill: (sig) => proc.kill(sig),
        exited: proc.exited.then(() => undefined),
      }));
    },
    postConfig: async (port, devPort, config, daemonToken) => {
      // Daemon's TenantConfig wire shape is `{ git, application }`. We
      // always pin `application.port` to the link-allocated devPort so
      // co-tenant sandboxes can't collide on the host network; the
      // caller-supplied workload only drives runtime + packageManager
      // (without these the orchestrator falls through to lockfile
      // autodetect, which on a repo with `yarn.lock` picks yarn — a
      // package manager the desktop daemon can't reliably PATH-shim).
      const application: Record<string, unknown> = { port: devPort };
      if (config.workload) {
        application.runtime = config.workload.runtime;
        application.packageManager = {
          name: config.workload.packageManager,
          ...(config.workload.packageManagerPath
            ? { path: config.workload.packageManagerPath }
            : {}),
        };
      }
      const payload: Record<string, unknown> = { application };
      if (config.repo) {
        payload.git = {
          repository: {
            cloneUrl: config.repo.cloneUrl,
            branch: config.repo.branch,
          },
          ...(config.repo.userName && config.repo.userEmail
            ? {
                identity: {
                  userName: config.repo.userName,
                  userEmail: config.repo.userEmail,
                },
              }
            : {}),
        };
      }
      await daemonPostConfig(`http://127.0.0.1:${port}`, daemonToken, payload);
    },
    waitForHealth: async (port) => {
      await waitForDaemonReady(`http://127.0.0.1:${port}`);
    },
    maxSandboxes: 20,
    onEvent: opts.monitor?.onEvent,
  });

  const ingress = await startLocalIngress({
    port: opts.port,
    lookupSandboxPort: (handle) => provider.proxyPort(handle),
  });
  ingressPort = ingress.port;
  console.log(
    `Local ingress listening on http://127.0.0.1:${ingress.port} (use http://<handle>.localhost:${ingress.port}/)`,
  );
  opts.monitor?.onIngress?.(ingress.port);

  // The control handler reverse-proxies `/_sandbox/<handle>/*` to each
  // spawned sandbox daemon's local port. The provider exposes `proxyPort`
  // and `acquireDispatch` to map handle → port and track in-flight calls.
  const controlHandler = createControlHandler({ provider });

  const wsUrl = (() => {
    const u = new URL("/api/links/connect", opts.clusterBaseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  })();

  const cluster = await connectToCluster({
    url: wsUrl,
    accessToken: session.accessToken,
    // Re-resolve (and refresh) the bearer before each (re)connect so a
    // reconnect after the startup token expired presents a fresh token rather
    // than the dead one — the cause of the WS "Expected 101 status code" loop.
    // getValidSession refreshes via the refresh token and rewrites disk; a
    // transient failure propagates (cluster-connection retries with backoff),
    // and a null result (no session / refresh token rejected) is fatal so the
    // daemon stops and asks the user to re-auth instead of spinning forever.
    getAccessToken: async () => {
      const fresh = await getValidSession({
        dataDir: opts.dataDir,
        target: opts.clusterBaseUrl,
      });
      if (!fresh) {
        throw Object.assign(
          new Error(
            `Session for ${opts.clusterBaseUrl} is no longer valid — run \`deco auth login --target ${opts.clusterBaseUrl}\` and restart \`deco link\`.`,
          ),
          { fatal: true },
        );
      }
      return fresh.accessToken;
    },
    hello: {
      previewPort: ingress.port,
      machineId,
      hostname,
      cliVersion,
      capabilities: await detectCapabilities(),
    },
    controlHandler,
    onConnected: () => {
      opts.monitor?.onCluster?.("linked");
      console.log(`Linked to ${opts.clusterBaseUrl}`);
    },
  });

  let resolveStopped!: (code: number) => void;
  const stopped = new Promise<number>((r) => {
    resolveStopped = r;
  });
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down…");
    try {
      await cluster.close();
    } catch {
      /* */
    }
    try {
      await ingress.stop();
    } catch {
      /* */
    }
    try {
      await provider.shutdown();
    } catch {
      /* */
    }
    resolveStopped(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  void cluster.closed.then(() => {
    opts.monitor?.onCluster?.("closed");
    if (!shuttingDown) {
      console.error("Cluster connection closed permanently; exiting.");
      void shutdown();
    }
  });

  return { stopped, stop: shutdown };
}
