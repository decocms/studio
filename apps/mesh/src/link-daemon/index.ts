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
import type { Session } from "../cli/lib/session";
import {
  createDesktopSandboxProvider,
  type SpawnResult,
} from "./user-desktop-provider";

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

  const innerSpawn = createDefaultDaemonSpawn(opts.dataDir);
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
  });

  const ingress = await startLocalIngress({
    port: opts.port,
    lookupSandboxPort: (handle) => provider.proxyPort(handle),
  });
  ingressPort = ingress.port;
  console.log(
    `Local ingress listening on http://127.0.0.1:${ingress.port} (use http://<handle>.localhost:${ingress.port}/)`,
  );

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
    hello: {
      previewPort: ingress.port,
      machineId,
      hostname,
      cliVersion,
      capabilities: await detectCapabilities(),
    },
    controlHandler,
    onConnected: () => console.log(`Linked to ${opts.clusterBaseUrl}`),
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
    if (!shuttingDown) {
      console.error("Cluster connection closed permanently; exiting.");
      void shutdown();
    }
  });

  return { stopped, stop: shutdown };
}
